#!/usr/bin/env node
/**
 * Google Tasks handler — list, create, update, complete tasks and task lists.
 */
import { workspace, readParams, respond, fail, truncate, cleanArgs } from './lib.js';

const ACTION_MAP = {
  list:        'list_tasks',
  get:         'get_task',
  manage:      'manage_task',
  list_lists:  'list_task_lists',
  get_list:    'get_task_list',
  manage_list: 'manage_task_list',
};

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown action "${p.action}". Valid actions: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  const { action: _, ...rest } = p;

  // Promote task_action to 'action' for manage
  if (p.action === 'manage' && rest.task_action) {
    rest.action = rest.task_action;
    delete rest.task_action;
  }

  // Promote list_action to 'action' for manage_list
  if (p.action === 'manage_list' && rest.list_action) {
    rest.action = rest.list_action;
    delete rest.list_action;
  }

  const args = cleanArgs(rest);

  const res = workspace(toolName, args);
  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

main();
