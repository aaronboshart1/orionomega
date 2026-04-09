#!/usr/bin/env node
/**
 * Google Apps Script handler — list, create, run scripts, manage deployments.
 */
import { workspace, readParams, respond, fail, truncate, cleanArgs } from './lib.js';

const ACTION_MAP = {
  list:               'list_script_projects',
  get:                'get_script_project',
  get_content:        'get_script_content',
  create:             'create_script_project',
  update_content:     'update_script_content',
  run:                'run_script_function',
  list_deployments:   'list_deployments',
  manage_deployment:  'manage_deployment',
  list_processes:     'list_script_processes',
};

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown action "${p.action}". Valid actions: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  const { action: _, ...rest } = p;

  // Promote deployment_action to 'action' for manage_deployment
  if (p.action === 'manage_deployment' && rest.deployment_action) {
    rest.action = rest.deployment_action;
    delete rest.deployment_action;
  }

  // Map source_code → content for update_script_content
  if (p.action === 'update_content' && rest.source_code) {
    rest.content = rest.source_code;
    delete rest.source_code;
  }

  const args = cleanArgs(rest);

  const res = workspace(toolName, args);
  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

main();
