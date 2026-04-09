#!/usr/bin/env node
/**
 * Google Chat handler — send/search messages, manage spaces, reactions, attachments.
 */
import { workspace, readParams, respond, fail, truncate, cleanArgs } from './lib.js';

const ACTION_MAP = {
  get_messages:         'get_messages',
  send:                 'send_message',
  search:               'search_messages',
  react:                'create_reaction',
  list_spaces:          'list_spaces',
  download_attachment:  'download_chat_attachment',
};

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown action "${p.action}". Valid actions: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  const { action: _, ...rest } = p;
  const args = cleanArgs(rest);

  const res = workspace(toolName, args);
  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

main();
