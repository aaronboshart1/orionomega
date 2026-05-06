#!/usr/bin/env node
/**
 * Google Forms handler — create forms, list/get responses, manage settings.
 */
import { workspace, readParams, respond, fail, truncate, cleanArgs, pickAccountFromArgs } from './lib.js';

const ACTION_MAP = {
  create:          'create_form',
  get:             'get_form',
  list_responses:  'list_form_responses',
  get_response:    'get_form_response',
  set_publish:     'set_publish_settings',
  batch_update:    'batch_update_form',
};

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown action "${p.action}". Valid actions: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  const { action: _, ...rest } = p;
  const { accountId, rest: rest2 } = pickAccountFromArgs(rest);
  const args = cleanArgs(rest2);

  const res = await workspace(toolName, args, { accountId });
  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

main();
