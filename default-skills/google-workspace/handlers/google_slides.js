#!/usr/bin/env node
/**
 * Google Slides handler — create presentations, get slides, batch update, manage comments.
 */
import { workspace, readParams, respond, fail, truncate, cleanArgs } from './lib.js';

const ACTION_MAP = {
  create:          'create_presentation',
  get:             'get_presentation',
  batch_update:    'batch_update_presentation',
  get_page:        'get_page',
  get_thumbnail:   'get_page_thumbnail',
  list_comments:   'list_presentation_comments',
  manage_comment:  'manage_presentation_comment',
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
