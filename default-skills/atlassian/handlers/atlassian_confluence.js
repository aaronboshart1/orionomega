#!/usr/bin/env node
/**
 * Confluence handler — get, create, update pages, list spaces, search via CQL, manage comments.
 * Maps actions to Atlassian Rovo MCP Server tool names.
 */
import { mcpCall, readParams, respond, fail, truncate, cleanArgs, isProductEnabled, getMaxResults, getCloudId, getConfig } from './lib.js';

const ACTION_MAP = {
  get_page:               'getConfluencePage',
  create_page:            'createConfluencePage',
  update_page:            'updateConfluencePage',
  get_descendants:        'getConfluencePageDescendants',
  list_spaces:            'getConfluenceSpaces',
  list_pages_in_space:    'getPagesInConfluenceSpace',
  search_cql:             'searchConfluenceUsingCql',
  get_footer_comments:    'getConfluencePageFooterComments',
  get_inline_comments:    'getConfluencePageInlineComments',
  get_comment_children:   'getConfluenceCommentChildren',
  create_footer_comment:  'createConfluenceFooterComment',
  create_inline_comment:  'createConfluenceInlineComment',
};

async function main() {
  if (!isProductEnabled('confluence')) {
    fail('Confluence is not enabled. Go to Settings → Skills → Atlassian → Enable Confluence.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown Confluence action "${p.action}". Valid: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  const config = getConfig();
  const args = buildArgs(p, config);
  const res = await mcpCall(toolName, args);

  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

function buildArgs(p, config) {
  const cloudId = getCloudId(p.cloud_id);
  const maxResults = getMaxResults(p.max_results);

  switch (p.action) {
    case 'get_page':
      if (!p.page_id) fail('page_id is required for get_page');
      return cleanArgs({ pageId: p.page_id, cloudId });

    case 'create_page': {
      if (!p.title) fail('title is required for create_page');
      if (!p.body) fail('body is required for create_page');
      const spaceKey = p.space_key || config.default_confluence_space;
      return cleanArgs({
        spaceKey,
        title: p.title,
        body: p.body,
        parentPageId: p.parent_page_id,
        cloudId,
      });
    }

    case 'update_page':
      if (!p.page_id) fail('page_id is required for update_page');
      return cleanArgs({
        pageId: p.page_id,
        title: p.title,
        body: p.body,
        cloudId,
      });

    case 'get_descendants':
      if (!p.parent_page_id && !p.page_id) fail('page_id or parent_page_id is required for get_descendants');
      return cleanArgs({ parentPageId: p.parent_page_id || p.page_id, cloudId });

    case 'list_spaces':
      return cleanArgs({ cloudId });

    case 'list_pages_in_space': {
      const spaceId = p.space_id || config.default_confluence_space;
      if (!spaceId) fail('space_id is required for list_pages_in_space');
      return cleanArgs({ spaceId, cloudId });
    }

    case 'search_cql':
      if (!p.cql) fail('cql is required for search_cql');
      return cleanArgs({ cql: p.cql, limit: maxResults, cloudId });

    case 'get_footer_comments':
      if (!p.page_id) fail('page_id is required for get_footer_comments');
      return cleanArgs({ pageId: p.page_id, cloudId });

    case 'get_inline_comments':
      if (!p.page_id) fail('page_id is required for get_inline_comments');
      return cleanArgs({ pageId: p.page_id, cloudId });

    case 'get_comment_children':
      if (!p.comment_id) fail('comment_id is required for get_comment_children');
      return cleanArgs({ commentId: p.comment_id, cloudId });

    case 'create_footer_comment':
      if (!p.page_id) fail('page_id is required for create_footer_comment');
      if (!p.comment_text) fail('comment_text is required for create_footer_comment');
      return cleanArgs({ pageId: p.page_id, body: p.comment_text, cloudId });

    case 'create_inline_comment':
      if (!p.page_id) fail('page_id is required for create_inline_comment');
      if (!p.comment_text) fail('comment_text is required for create_inline_comment');
      return cleanArgs({
        pageId: p.page_id,
        body: p.comment_text,
        inlineTextSelection: p.inline_text_selection,
        cloudId,
      });

    default:
      return cleanArgs({ cloudId });
  }
}

main();
