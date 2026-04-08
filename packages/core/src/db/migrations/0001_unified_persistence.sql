-- Migration: 0001_unified_persistence
-- Creates unified persistence tables for gateway sessions, messages, workflows,
-- orchestration events, memory events, run history, and client state.
-- Tables: sessions, events, messages, workflows, workflow_events, memory_events,
--         run_history, client_state

CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT    PRIMARY KEY,
  name                 TEXT,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  model                TEXT,
  agent_mode           TEXT,
  total_cost_usd       REAL,
  total_input_tokens   INTEGER,
  total_output_tokens  INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  timestamp    TEXT    NOT NULL,
  event_type   TEXT    NOT NULL,
  workflow_id  TEXT,
  payload      TEXT    -- JSON
);

CREATE INDEX IF NOT EXISTS idx_events_session
  ON events(session_id);

CREATE INDEX IF NOT EXISTS idx_events_workflow
  ON events(workflow_id);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT    PRIMARY KEY,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  metadata    TEXT,   -- JSON
  reply_to_id TEXT,
  attachments TEXT,   -- JSON
  status      TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages(session_id);

CREATE TABLE IF NOT EXISTS workflows (
  id           TEXT    PRIMARY KEY,
  session_id   TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name         TEXT,
  status       TEXT,
  template     TEXT,
  node_count   INTEGER,
  started_at   TEXT,
  completed_at TEXT,
  duration_sec REAL,
  cost_usd     REAL,
  summary      TEXT,
  graph_state  TEXT    -- JSON
);

CREATE TABLE IF NOT EXISTS workflow_events (
  id          TEXT    PRIMARY KEY,
  workflow_id TEXT    NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  event_type  TEXT    NOT NULL,
  node_id     TEXT,
  payload     TEXT    -- JSON
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_workflow
  ON workflow_events(workflow_id);

CREATE TABLE IF NOT EXISTS memory_events (
  id         TEXT    PRIMARY KEY,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  op         TEXT    NOT NULL,
  detail     TEXT,
  bank       TEXT,
  meta       TEXT    -- JSON
);

CREATE TABLE IF NOT EXISTS run_history (
  id             TEXT    PRIMARY KEY,
  session_id     TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workflow_id    TEXT    REFERENCES workflows(id) ON DELETE CASCADE,
  model          TEXT,
  duration_sec   REAL,
  cost_usd       REAL,
  worker_count   INTEGER,
  model_usage    TEXT,   -- JSON
  tool_call_count INTEGER
);

CREATE TABLE IF NOT EXISTS client_state (
  client_id        TEXT    NOT NULL,
  session_id       TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_mode       TEXT,
  scroll_position  INTEGER,
  active_panel     TEXT,
  last_seen_seq    INTEGER,
  PRIMARY KEY (client_id, session_id)
);
