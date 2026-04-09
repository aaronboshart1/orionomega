#!/usr/bin/env node
/**
 * Google Contacts handler — search, list, manage contacts and contact groups.
 */
import { workspace, readParams, respond, fail, truncate, cleanArgs } from './lib.js';

const ACTION_MAP = {
  search:        'search_contacts',
  get:           'get_contact',
  list:          'list_contacts',
  manage:        'manage_contact',
  list_groups:   'list_contact_groups',
  get_group:     'get_contact_group',
  manage_group:  'manage_contact_group',
  batch_manage:  'manage_contacts_batch',
};

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown action "${p.action}". Valid actions: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  const { action: _, ...rest } = p;

  // Promote contact_action to 'action' for manage
  if (p.action === 'manage' && rest.contact_action) {
    rest.action = rest.contact_action;
    delete rest.contact_action;
  }

  // Promote group_action to 'action' for manage_group
  if (p.action === 'manage_group' && rest.group_action) {
    rest.action = rest.group_action;
    delete rest.group_action;
  }

  const args = cleanArgs(rest);

  const res = workspace(toolName, args);
  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

main();
