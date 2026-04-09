#!/usr/bin/env node
/**
 * Google Calendar handler — list calendars, get events, manage events.
 */
import { workspace, readParams, respond, fail, truncate, cleanArgs } from './lib.js';

const ACTION_MAP = {
  list_calendars: 'list_calendars',
  get_events:     'get_events',
  manage_event:   'manage_event',
};

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown action "${p.action}". Valid actions: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  const { action: _, ...rest } = p;

  // For manage_event, promote event_action to 'action' in args (workspace-mcp convention)
  if (p.action === 'manage_event' && rest.event_action) {
    rest.action = rest.event_action;
    delete rest.event_action;
  }

  const args = cleanArgs(rest);

  const res = workspace(toolName, args);
  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

main();
