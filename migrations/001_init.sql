-- Social Inbox schema v1. Timestamps are unix epoch milliseconds.

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  n    INTEGER NOT NULL
);

CREATE TABLE accounts (
  id         TEXT PRIMARY KEY,           -- e.g. "ig"
  net        TEXT NOT NULL,              -- "ig"
  native_id  TEXT NOT NULL,              -- IG professional account id
  username   TEXT,
  page_id    TEXT,                       -- linked Facebook Page id
  meta       TEXT,                       -- JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tokens (
  account_id TEXT NOT NULL,
  kind       TEXT NOT NULL,              -- "page" | "user"
  enc        TEXT NOT NULL,              -- AES-256-GCM, see core/crypto.ts
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind)
);

CREATE TABLE posts (
  id         TEXT PRIMARY KEY,           -- short id "p9"
  net        TEXT NOT NULL,
  native_id  TEXT NOT NULL,
  permalink  TEXT,
  caption    TEXT,
  ts         INTEGER,
  cm_count   INTEGER,
  UNIQUE (net, native_id)
);

CREATE TABLE threads (
  id          TEXT PRIMARY KEY,          -- short id "t3f"
  net         TEXT NOT NULL,
  native_id   TEXT NOT NULL,             -- "dm:<igsid>" or top-level comment id
  src         TEXT NOT NULL,
  who         TEXT,
  author_id   TEXT,
  post_id     TEXT,
  last_ts     INTEGER,
  last_in_ts  INTEGER,                   -- last inbound message (reply-window anchor)
  last_out_ts INTEGER,
  n_in        INTEGER NOT NULL DEFAULT 0,
  n_out       INTEGER NOT NULL DEFAULT 0,
  note        TEXT,                      -- agent-written cached summary
  note_tags   TEXT,                      -- JSON array
  note_at     INTEGER,
  UNIQUE (net, native_id)
);

CREATE TABLE items (
  id         TEXT PRIMARY KEY,           -- short id "i7k"
  seq        INTEGER NOT NULL UNIQUE,    -- monotonic change sequence (delta cursors)
  net        TEXT NOT NULL,
  native_id  TEXT NOT NULL,
  src        TEXT NOT NULL,
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  author_id  TEXT,
  who        TEXT,
  text       TEXT,
  ts         INTEGER NOT NULL,
  me         INTEGER NOT NULL DEFAULT 0,
  post_id    TEXT,
  parent_nid TEXT,
  permalink  TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  read       INTEGER NOT NULL DEFAULT 0,
  labels     TEXT NOT NULL DEFAULT '[]', -- JSON array
  raw        TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (net, native_id)
);
CREATE INDEX items_unread ON items (read, seq);
CREATE INDEX items_thread ON items (thread_id, ts);
CREATE INDEX items_author ON items (author_id);

CREATE VIRTUAL TABLE items_fts USING fts5 (
  text, who, content = 'items', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (rowid, text, who) VALUES (new.rowid, new.text, new.who);
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, text, who) VALUES ('delete', old.rowid, old.text, old.who);
END;
CREATE TRIGGER items_au AFTER UPDATE OF text, who ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, text, who) VALUES ('delete', old.rowid, old.text, old.who);
  INSERT INTO items_fts (rowid, text, who) VALUES (new.rowid, new.text, new.who);
END;

CREATE TABLE drafts (
  id          TEXT PRIMARY KEY,          -- short id "d12"
  kind        TEXT NOT NULL,             -- reply | dm | private_reply | hide | unhide | delete
  item_id     TEXT REFERENCES items(id),
  thread_id   TEXT REFERENCES threads(id),
  text        TEXT,
  status      TEXT NOT NULL,             -- pending | approved | rejected | sending | sent | failed
  idem_key    TEXT UNIQUE,
  checks      TEXT,                      -- JSON array
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  confirmed   TEXT,                      -- agent-confirmed approval reference
  sent_at     INTEGER,
  native_id   TEXT,                      -- id returned by the platform
  result      TEXT,                      -- JSON native response
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER                    -- outbox retry time
);
CREATE INDEX drafts_status ON drafts (status);

CREATE TABLE audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  ref    TEXT,
  detail TEXT
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN
  SELECT RAISE(ABORT, 'audit is append-only');
END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN
  SELECT RAISE(ABORT, 'audit is append-only');
END;

CREATE TABLE cursors (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE api_keys (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE,       -- sha256 hex
  scopes     TEXT NOT NULL,              -- comma separated
  created_at INTEGER NOT NULL,
  last_used  INTEGER
);

CREATE TABLE oauth_states (
  state      TEXT PRIMARY KEY,
  net        TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE deletions (
  code       TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  n          INTEGER NOT NULL,
  ts         INTEGER NOT NULL
);
