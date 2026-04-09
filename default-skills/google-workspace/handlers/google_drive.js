#!/usr/bin/env node
/**
 * Google Drive handler — search, read, create, copy, share files and folders.
 */
import { workspace, readParams, respond, fail, truncate, cleanArgs } from './lib.js';

const ACTION_MAP = {
  search:          'search_drive_files',
  get:             'get_drive_file_content',
  download_url:    'get_drive_file_download_url',
  share_link:      'get_drive_shareable_link',
  create:          'create_drive_file',
  create_folder:   'create_drive_folder',
  import:          'import_to_google_doc',
  list:            'list_drive_items',
  copy:            'copy_drive_file',
  update:          'update_drive_file',
  manage_access:   'manage_drive_access',
  set_permissions: 'set_drive_file_permissions',
  get_permissions: 'get_drive_file_permissions',
  check_public:    'check_drive_file_public_access',
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
