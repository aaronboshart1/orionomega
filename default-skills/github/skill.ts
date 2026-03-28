import { BaseSkill } from '@orionomega/skills-sdk';
import type { SkillTool, SkillContext } from '@orionomega/skills-sdk';

export default class GitHubSkill extends BaseSkill {
  private defaultOwner = '';

  override async initialize(ctx: SkillContext): Promise<void> {
    await super.initialize(ctx);
    this.defaultOwner = String(ctx.config.default_owner ?? '');

    if (ctx.secrets.gh_token) {
      process.env.GH_TOKEN = ctx.secrets.gh_token;
      ctx.logger.info('GitHub token configured from skill settings');
    }
  }

  override async activate(): Promise<void> {
    await super.activate();
    this.ctx.logger.info('GitHubSkill activated', {
      defaultOwner: this.defaultOwner || '(not set)',
    });
  }

  getTools(): SkillTool[] {
    return [
      {
        name: 'gh_repo',
        description: 'Manage GitHub repositories: list, view, clone, create, fork, archive, delete.',
        handler: 'handlers/gh_repo.js',
        timeout: 30_000,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'view', 'clone', 'create', 'fork', 'archive', 'delete', 'rename'] },
            repo: { type: 'string' },
          },
          required: ['action'],
        },
      },
      {
        name: 'gh_issue',
        description: 'Manage GitHub issues: list, view, create, edit, close, reopen, comment.',
        handler: 'handlers/gh_issue.js',
        timeout: 30_000,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'view', 'create', 'edit', 'close', 'reopen', 'comment'] },
            repo: { type: 'string' },
          },
          required: ['action'],
        },
      },
      {
        name: 'gh_pr',
        description: 'Manage pull requests: list, view, create, edit, merge, close, reopen.',
        handler: 'handlers/gh_pr.js',
        timeout: 60_000,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'view', 'create', 'edit', 'merge', 'close', 'reopen'] },
            repo: { type: 'string' },
          },
          required: ['action'],
        },
      },
      {
        name: 'gh_workflow',
        description: 'Manage GitHub Actions: list workflows, view/trigger/cancel runs.',
        handler: 'handlers/gh_workflow.js',
        timeout: 30_000,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'runs', 'view', 'trigger', 'cancel', 'rerun'] },
            repo: { type: 'string' },
          },
          required: ['action'],
        },
      },
      {
        name: 'gh_release',
        description: 'Manage releases: list, view, create, edit, delete.',
        handler: 'handlers/gh_release.js',
        timeout: 60_000,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'view', 'create', 'edit', 'delete'] },
            repo: { type: 'string' },
          },
          required: ['action'],
        },
      },
      {
        name: 'gh_api',
        description: 'Make raw GitHub API requests.',
        handler: 'handlers/gh_api.js',
        timeout: 30_000,
        inputSchema: {
          type: 'object',
          properties: {
            endpoint: { type: 'string' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          },
          required: ['endpoint'],
        },
      },
    ];
  }
}
