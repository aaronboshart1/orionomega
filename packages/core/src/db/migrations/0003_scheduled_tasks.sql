-- Migration: 0003_scheduled_tasks
-- Adds tables for the agent task scheduler: scheduled_tasks holds the
-- recurring/one-shot schedule definitions, task_executions records each
-- run (cron or manual) for history/audit purposes.

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id              TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL UNIQUE,
  description     TEXT    NOT NULL DEFAULT '',
  cron_expr       TEXT    NOT NULL,
  prompt          TEXT    NOT NULL,
  agent_mode      TEXT    NOT NULL DEFAULT 'orchestrate',
  session_id      TEXT    NOT NULL DEFAULT 'default',
  status          TEXT    NOT NULL DEFAULT 'active',
  timezone        TEXT    NOT NULL DEFAULT 'UTC',
  overlap_policy  TEXT    NOT NULL DEFAULT 'skip',
  max_retries     INTEGER NOT NULL DEFAULT 0,
  timeout_sec     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  last_run_at     TEXT,
  next_run_at     TEXT,
  last_status     TEXT,
  run_count       INTEGER NOT NULL DEFAULT 0,
  run_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(next_run_at);

CREATE TABLE IF NOT EXISTS task_executions (
  id              TEXT    PRIMARY KEY,
  task_id         TEXT    NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  status          TEXT    NOT NULL DEFAULT 'running',
  started_at      TEXT    NOT NULL,
  completed_at    TEXT,
  duration_sec    REAL,
  error           TEXT,
  trigger_type    TEXT    NOT NULL DEFAULT 'cron'
);

CREATE INDEX IF NOT EXISTS idx_task_executions_task_id ON task_executions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_executions_started_at ON task_executions(started_at);
