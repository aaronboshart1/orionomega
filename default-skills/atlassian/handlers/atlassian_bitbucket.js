#!/usr/bin/env node
/**
 * Bitbucket Cloud handler — repos, PRs, pipelines, deployments, environments.
 * Maps actions to Atlassian Rovo MCP Server Bitbucket tool names.
 * Note: Bitbucket tools require API token authentication with Bitbucket scopes.
 */
import { mcpCall, readParams, respond, fail, truncate, cleanArgs, isProductEnabled, getCloudId } from './lib.js';

// Bitbucket Rovo tools use a resource + action pattern.
// We flatten to simple action names for a better UX.
const ACTION_MAP = {
  // read_bitbucket
  list_workspaces:     { tool: 'bitbucketWorkspace', action: 'list' },
  get_workspace:       { tool: 'bitbucketWorkspace', action: 'get' },
  list_repos:          { tool: 'bitbucketRepository', action: 'list' },
  get_repo:            { tool: 'bitbucketRepository', action: 'get' },
  get_default_reviewers: { tool: 'bitbucketRepository', action: 'defaultReviewers' },
  my_pull_requests:    { tool: 'bitbucketUser', action: 'pullRequests' },
  list_pull_requests:  { tool: 'bitbucketPullRequest', action: 'list' },
  get_pull_request:    { tool: 'bitbucketPullRequest', action: 'get' },
  get_pr_diff:         { tool: 'bitbucketPullRequest', action: 'diff' },
  get_pr_comments:     { tool: 'bitbucketPullRequest', action: 'comments' },
  get_branch:          { tool: 'bitbucketRepoContent', action: 'branch.get' },
  get_commit:          { tool: 'bitbucketRepoContent', action: 'commit.get' },
  list_files:          { tool: 'bitbucketRepoContent', action: 'files.get' },
  list_pipelines:      { tool: 'bitbucketPipeline', action: 'list' },
  get_pipeline:        { tool: 'bitbucketPipeline', action: 'get' },
  get_pipeline_steps:  { tool: 'bitbucketPipeline', action: 'steps' },
  get_step_log:        { tool: 'bitbucketPipeline', action: 'step.log' },
  list_deployments:    { tool: 'bitbucketDeployment', action: 'list' },
  get_deployment:      { tool: 'bitbucketDeployment', action: 'get' },
  list_environments:   { tool: 'bitbucketEnvironment', action: 'list' },

  // write_bitbucket
  create_pull_request: { tool: 'bitbucketPullRequest', action: 'create' },
  merge_pull_request:  { tool: 'bitbucketPullRequest', action: 'merge' },
  approve_pull_request: { tool: 'bitbucketPullRequest', action: 'approve' },
  comment_on_pr:       { tool: 'bitbucketPullRequest', action: 'comment' },
  create_branch:       { tool: 'bitbucketRepoContent', action: 'branch.create' },
  create_commit:       { tool: 'bitbucketRepoContent', action: 'commit.create' },
  run_pipeline:        { tool: 'bitbucketPipeline', action: 'run' },
  create_environment:  { tool: 'bitbucketEnvironment', action: 'create' },
  update_environment:  { tool: 'bitbucketEnvironment', action: 'update' },
  delete_environment:  { tool: 'bitbucketEnvironment', action: 'delete' },
};

async function main() {
  if (!isProductEnabled('bitbucket')) {
    fail('Bitbucket is not enabled. Go to Settings → Skills → Atlassian → Enable Bitbucket. Note: Bitbucket requires API token authentication with Bitbucket scopes.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  const mapping = ACTION_MAP[p.action];
  if (!mapping) {
    fail(`Unknown Bitbucket action "${p.action}". Valid: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  const args = buildArgs(p, mapping);
  const res = await mcpCall(mapping.tool, args);

  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

function buildArgs(p, mapping) {
  const cloudId = getCloudId(p.cloud_id);

  // Build common args
  const args = cleanArgs({
    action: mapping.action,
    workspace: p.workspace,
    repoSlug: p.repo_slug,
    pullRequestId: p.pr_id,
    branch: p.branch,
    commitHash: p.commit_hash,
    title: p.title,
    description: p.description,
    sourceBranch: p.source_branch,
    destinationBranch: p.destination_branch,
    comment: p.comment,
    pipelineUuid: p.pipeline_id,
    stepUuid: p.step_id,
    environmentUuid: p.environment_id,
    deploymentUuid: p.deployment_id,
    files: p.files,
    commitMessage: p.commit_message,
    cloudId,
  });

  return args;
}

main();
