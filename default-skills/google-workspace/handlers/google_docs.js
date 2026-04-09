#!/usr/bin/env node
/**
 * Google Docs handler — create, read, edit, format documents.
 */
import { workspace, readParams, respond, fail, truncate, cleanArgs } from './lib.js';

const ACTION_MAP = {
  get:                   'get_doc_content',
  create:                'create_doc',
  modify_text:           'modify_doc_text',
  get_markdown:          'get_doc_as_markdown',
  export_pdf:            'export_doc_to_pdf',
  search:                'search_docs',
  find_replace:          'find_and_replace_doc',
  list_in_folder:        'list_docs_in_folder',
  insert_elements:       'insert_doc_elements',
  update_paragraph:      'update_paragraph_style',
  insert_image:          'insert_doc_image',
  update_headers_footers:'update_doc_headers_footers',
  batch_update:          'batch_update_doc',
  inspect_structure:     'inspect_doc_structure',
  create_table:          'create_table_with_data',
  list_comments:         'list_document_comments',
  manage_comment:        'manage_document_comment',
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

  // Map comment_content → content for manage_comment
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
