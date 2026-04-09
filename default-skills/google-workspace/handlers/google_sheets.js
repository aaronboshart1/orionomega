#!/usr/bin/env node
/**
 * Google Sheets handler — read/write cells, create spreadsheets, format ranges.
 */
import { workspace, readParams, respond, fail, truncate, cleanArgs } from './lib.js';

const ACTION_MAP = {
  read:                'read_sheet_values',
  write:               'modify_sheet_values',
  create:              'create_spreadsheet',
  list:                'list_spreadsheets',
  get_info:            'get_spreadsheet_info',
  format:              'format_sheet_range',
  create_sheet:        'create_sheet',
  list_comments:       'list_spreadsheet_comments',
  manage_comment:      'manage_spreadsheet_comment',
  conditional_format:  'manage_conditional_formatting',
};

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown action "${p.action}". Valid actions: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  const { action: _, ...rest } = p;

  // Promote comment_action to 'action' for manage_comment
  if (p.action === 'manage_comment' && rest.comment_action) {
    rest.action = rest.comment_action;
    delete rest.comment_action;
  }

  if (p.action === 'manage_comment' && rest.comment_content) {
    rest.content = rest.comment_content;
    delete rest.comment_content;
  }

  const args = cleanArgs(rest);

  const res = workspace(toolName, args);
  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

main();
