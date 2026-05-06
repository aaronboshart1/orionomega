-- Migration: 0005_scheduled_tasks_attachments
-- Adds an `attachments` column to scheduled_tasks for persisting file
-- attachments staged with a scheduled prompt. Stored as JSON text so the
-- scheduler can replay the same `{name,size,type,data?,textContent?}` shape
-- the chat WebSocket already sends through MainAgent.handleMessage().

ALTER TABLE scheduled_tasks ADD COLUMN attachments TEXT;
