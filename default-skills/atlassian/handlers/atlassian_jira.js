#!/usr/bin/env node
/**
 * Jira handler — get, create, edit, transition, comment, search issues.
 * Maps actions to Atlassian Rovo MCP Server tool names.
 */
import { mcpCall, readParams, respond, fail, truncate, cleanArgs, isProductEnabled, getMaxResults, getCloudId, getConfig } from './lib.js';

// Maps skill action → Rovo MCP tool name
const ACTION_MAP = {
  get_issue:          'getJiraIssue',
  create_issue:       'createJiraIssue',
  edit_issue:         'editJiraIssue',
  transition_issue:   'transitionJiraIssue',
  add_comment:        'addCommentToJiraIssue',
  add_worklog:        'addWorklogToJiraIssue',
  search_jql:         'searchJiraIssuesUsingJql',
  list_projects:      'getVisibleJiraProjects',
  get_issue_types:    'getJiraProjectIssueTypesMetadata',
  get_transitions:    'getTransitionsForJiraIssue',
  get_link_types:     'getIssueLinkTypes',
  get_remote_links:   'getJiraIssueRemoteIssueLinks',
  lookup_user:        'lookupJiraAccountId',
  get_field_metadata: 'getJiraIssueTypeMetaWithFields',
};

async function main() {
  if (!isProductEnabled('jira')) {
    fail('Jira is not enabled. Go to Settings → Skills → Atlassian → Enable Jira.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown Jira action "${p.action}". Valid: ${Object.keys(ACTION_MAP).join(', ')}`);
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
    case 'get_issue':
      return cleanArgs({ issueIdOrKey: p.issue_key, cloudId });

    case 'create_issue': {
      const projectKey = p.project_key || config.default_jira_project;
      if (!projectKey) fail('project_key is required for create_issue');
      if (!p.summary) fail('summary is required for create_issue');
      return cleanArgs({
        projectKey,
        issueTypeName: p.issue_type || 'Task',
        summary: p.summary,
        description: p.description,
        cloudId,
        ...p.fields,
      });
    }

    case 'edit_issue':
      if (!p.issue_key) fail('issue_key is required for edit_issue');
      return cleanArgs({
        issueIdOrKey: p.issue_key,
        summary: p.summary,
        description: p.description,
        cloudId,
        ...p.fields,
      });

    case 'transition_issue':
      if (!p.issue_key) fail('issue_key is required for transition_issue');
      if (!p.transition_id) fail('transition_id is required for transition_issue');
      return cleanArgs({
        issueIdOrKey: p.issue_key,
        transitionId: p.transition_id,
        cloudId,
      });

    case 'add_comment':
      if (!p.issue_key) fail('issue_key is required for add_comment');
      if (!p.comment) fail('comment is required for add_comment');
      return cleanArgs({
        issueIdOrKey: p.issue_key,
        body: p.comment,
        cloudId,
      });

    case 'add_worklog':
      if (!p.issue_key) fail('issue_key is required for add_worklog');
      if (!p.time_spent) fail('time_spent is required for add_worklog');
      return cleanArgs({
        issueIdOrKey: p.issue_key,
        timeSpent: p.time_spent,
        cloudId,
      });

    case 'search_jql':
      if (!p.jql) fail('jql is required for search_jql');
      return cleanArgs({ jql: p.jql, maxResults, cloudId });

    case 'list_projects':
      return cleanArgs({ cloudId });

    case 'get_issue_types': {
      const projKey = p.project_key || config.default_jira_project;
      if (!projKey) fail('project_key is required for get_issue_types');
      return cleanArgs({ projectKey: projKey, cloudId });
    }

    case 'get_transitions':
      if (!p.issue_key) fail('issue_key is required for get_transitions');
      return cleanArgs({ issueIdOrKey: p.issue_key, cloudId });

    case 'get_link_types':
      return cleanArgs({ cloudId });

    case 'get_remote_links':
      if (!p.issue_key) fail('issue_key is required for get_remote_links');
      return cleanArgs({ issueIdOrKey: p.issue_key, cloudId });

    case 'lookup_user':
      if (!p.query) fail('query is required for lookup_user');
      return cleanArgs({ query: p.query, cloudId });

    case 'get_field_metadata': {
      const projKey = p.project_key || config.default_jira_project;
      if (!projKey) fail('project_key is required for get_field_metadata');
      return cleanArgs({ projectKey: projKey, issueTypeName: p.issue_type, cloudId });
    }

    default:
      return cleanArgs({ cloudId });
  }
}

main();
