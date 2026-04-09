#!/usr/bin/env node
/**
 * Gmail handler — search, read, send, draft, organize email.
 * Actions map to workspace-mcp CLI tool names.
 */
import { workspace, readParams, respond, fail, truncate, cleanArgs } from './lib.js';

// Maps action name → workspace-mcp tool name
const ACTION_MAP = {
  search:              'search_gmail_messages',
  get:                 'get_gmail_message_content',
  get_batch:           'get_gmail_messages_content_batch',
  send:                'send_gmail_message',
  draft:               'draft_gmail_message',
  get_thread:          'get_gmail_thread_content',
  get_thread_batch:    'get_gmail_threads_content_batch',
  list_labels:         'list_gmail_labels',
  manage_label:        'manage_gmail_label',
  modify_labels:       'modify_gmail_message_labels',
  batch_modify_labels: 'batch_modify_gmail_message_labels',
  list_filters:        'list_gmail_filters',
  manage_filter:       'manage_gmail_filter',
  get_attachment:      'get_gmail_attachment_content',
};

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown action "${p.action}". Valid actions: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  // Build args from params (exclude 'action' itself)
  const { action: _, ...rest } = p;
  const args = cleanArgs(rest);

  const res = workspace(toolName, args);
  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

main();
