-- Migration: 0002_workflow_triggering_message
-- Adds triggering_message_id to workflows for orchestration↔message linking,
-- and adds the missing session_id index on workflows for efficient lookups.

ALTER TABLE workflows ADD COLUMN triggering_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_workflows_session
  ON workflows(session_id);
