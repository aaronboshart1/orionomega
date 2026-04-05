-- Migration: 0000_coding_mode_schema
-- Creates tables for Coding Mode session persistence
-- Tables: coding_sessions, workflow_executions, workflow_steps, architect_reviews

CREATE TABLE IF NOT EXISTS coding_sessions (
  id               TEXT    PRIMARY KEY,
  conversation_id  TEXT    NOT NULL,
  repo_url         TEXT    NOT NULL,
  branch           TEXT    NOT NULL,
  workspace_path   TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_executions (
  id                TEXT    PRIMARY KEY,
  coding_session_id TEXT    NOT NULL REFERENCES coding_sessions(id) ON DELETE CASCADE,
  dag_definition    TEXT    NOT NULL, -- JSON
  status            TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at        TEXT,
  completed_at      TEXT,
  error             TEXT
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id                    TEXT    PRIMARY KEY,
  workflow_execution_id TEXT    NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  node_id               TEXT    NOT NULL,
  node_type             TEXT    NOT NULL,
  label                 TEXT    NOT NULL,
  status                TEXT    NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  input                 TEXT,    -- JSON
  output                TEXT,    -- JSON
  started_at            TEXT,
  completed_at          TEXT,
  error                 TEXT,
  depends_on            TEXT    NOT NULL DEFAULT '[]' -- JSON array of node IDs
);

CREATE TABLE IF NOT EXISTS architect_reviews (
  id                    TEXT    PRIMARY KEY,
  workflow_execution_id TEXT    NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  iteration             INTEGER NOT NULL,
  build_status          TEXT    NOT NULL CHECK (build_status IN ('pass', 'fail', 'skip')),
  test_status           TEXT    NOT NULL CHECK (test_status IN ('pass', 'fail', 'skip')),
  code_quality_score    REAL,
  decision              TEXT    NOT NULL CHECK (decision IN ('approve', 'retask')),
  feedback              TEXT    NOT NULL,
  reviewed_at           TEXT    NOT NULL
);

-- Indexes for common access patterns
CREATE INDEX IF NOT EXISTS idx_workflow_executions_session
  ON workflow_executions(coding_session_id);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_execution
  ON workflow_steps(workflow_execution_id);

CREATE INDEX IF NOT EXISTS idx_architect_reviews_execution
  ON architect_reviews(workflow_execution_id);

CREATE INDEX IF NOT EXISTS idx_coding_sessions_conversation
  ON coding_sessions(conversation_id);

CREATE INDEX IF NOT EXISTS idx_coding_sessions_status
  ON coding_sessions(status);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT    PRIMARY KEY,
  applied_at  TEXT    NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0000_coding_mode_schema', datetime('now'));
