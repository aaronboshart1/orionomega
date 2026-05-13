#!/usr/bin/env node
/**
 * Jira Service Management (JSM) Ops handler — alerts, on-call schedules, teams.
 * Maps actions to Atlassian Rovo MCP Server JSM tool names.
 * Note: JSM tools require API token authentication.
 */
import { mcpCall, readParams, respond, fail, truncate, cleanArgs, isProductEnabled, getCloudId, getConfig } from './lib.js';

const ACTION_MAP = {
  get_alert:        'getJsmOpsAlerts',
  search_alerts:    'getJsmOpsAlerts',
  get_schedule:     'getJsmOpsScheduleInfo',
  list_schedules:   'getJsmOpsScheduleInfo',
  get_team:         'getJsmOpsTeamInfo',
  list_teams:       'getJsmOpsTeamInfo',
  update_alert:     'updateJsmOpsAlert',
};

async function main() {
  if (!isProductEnabled('jsm')) {
    fail('Jira Service Management is not enabled. Go to Settings → Skills → Atlassian → Enable JSM. Note: JSM requires API token authentication.');
  }

  // JSM Ops tools only work with API token (Basic) auth via the Rovo MCP Server.
  const config = getConfig();
  const authMethod = config.auth_method || process.env.ATLASSIAN_AUTH_METHOD || 'oauth';
  if (authMethod !== 'basic') {
    fail(
      'JSM Ops tools require API token authentication (Basic auth). ' +
      'OAuth 2.0 (3LO) is not supported for JSM Ops via the Rovo MCP Server. ' +
      'Go to Settings → Skills → Atlassian → set Auth Method to "API Token", ' +
      'then enter your Atlassian email and API token.'
    );
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown JSM action "${p.action}". Valid: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  const args = buildArgs(p);
  const res = await mcpCall(toolName, args);

  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

function buildArgs(p) {
  const cloudId = getCloudId(p.cloud_id);

  switch (p.action) {
    case 'get_alert':
      if (!p.alert_id) fail('alert_id is required for get_alert');
      return cleanArgs({ alertIdOrAlias: p.alert_id, cloudId });

    case 'search_alerts':
      return cleanArgs({ query: p.query, cloudId });

    case 'get_schedule':
      if (!p.schedule_id) fail('schedule_id is required for get_schedule');
      return cleanArgs({ scheduleId: p.schedule_id, cloudId });

    case 'list_schedules':
      return cleanArgs({ cloudId });

    case 'get_team':
      if (!p.team_id) fail('team_id is required for get_team');
      return cleanArgs({ teamId: p.team_id, cloudId });

    case 'list_teams':
      return cleanArgs({ cloudId });

    case 'update_alert':
      if (!p.alert_id) fail('alert_id is required for update_alert');
      if (!p.alert_action) fail('alert_action is required for update_alert');
      return cleanArgs({
        alertIdOrAlias: p.alert_id,
        action: p.alert_action,
        cloudId,
      });

    default:
      return cleanArgs({ cloudId });
  }
}

main();
