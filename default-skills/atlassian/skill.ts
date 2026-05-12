import { BaseSkill } from '@orionomega/skills-sdk';
import type { SkillTool, SkillContext } from '@orionomega/skills-sdk';

// ─── Hardcoded OAuth Scopes (must match Atlassian Developer Console) ────

/** Jira platform REST API — classic scopes */
const JIRA_SCOPES = [
  'read:jira-work',
  'write:jira-work',
  'manage:jira-project',
  'manage:jira-configuration',
  'read:jira-user',
  'manage:jira-webhook',
  'manage:jira-data-provider',
] as const;

/** Jira Service Management API — classic scopes */
const JSM_SCOPES = [
  'read:servicedesk-request',
  'manage:servicedesk-customer',
  'write:servicedesk-request',
  'read:servicemanagement-insight-objects',
] as const;

/** Confluence API — classic scopes */
const CONFLUENCE_SCOPES = [
  'write:confluence-content',
  'read:confluence-space.summary',
  'write:confluence-space',
  'write:confluence-file',
  'read:confluence-props',
  'write:confluence-props',
  'manage:confluence-configuration',
  'read:confluence-content.all',
  'read:confluence-content.summary',
  'search:confluence',
  'read:confluence-content.permission',
  'read:confluence-user',
  'read:confluence-groups',
  'write:confluence-groups',
  'readonly:content.attachment:confluence',
] as const;

/** All approved scopes combined (space-separated for the OAuth authorization URL) */
export const ALL_APPROVED_SCOPES = [
  ...JIRA_SCOPES,
  ...JSM_SCOPES,
  ...CONFLUENCE_SCOPES,
  'offline_access',
] as const;

/** Pre-built space-separated scope string for the OAuth URL */
export const OAUTH_SCOPE_STRING = ALL_APPROVED_SCOPES.join(' ');

// ─── Hardcoded Tool Definitions ─────────────────────────────────────────

interface AtlassianToolDef {
  /** Which product-enablement flag gates this tool */
  product: string;
  /** The scopes this tool requires from the approved set */
  requiredScopes: readonly string[];
  /** The SkillTool definition */
  tool: SkillTool;
}

const TOOL_DEFINITIONS: readonly AtlassianToolDef[] = [
  {
    product: 'jira',
    requiredScopes: JIRA_SCOPES,
    tool: {
      name: 'atlassian_jira',
      description:
        'Manage Jira issues: get, create, edit, transition, comment, search via JQL, list projects and issue types.',
      handler: 'handlers/atlassian_jira.js',
      timeout: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'get_issue', 'create_issue', 'edit_issue', 'transition_issue',
              'add_comment', 'add_worklog', 'search_jql',
              'list_projects', 'get_issue_types', 'get_transitions',
              'get_link_types', 'get_remote_links', 'lookup_user',
              'get_field_metadata',
            ],
          },
          issue_key: { type: 'string' },
          project_key: { type: 'string' },
          jql: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    product: 'confluence',
    requiredScopes: CONFLUENCE_SCOPES,
    tool: {
      name: 'atlassian_confluence',
      description:
        'Manage Confluence pages: get, create, update, search via CQL, manage comments.',
      handler: 'handlers/atlassian_confluence.js',
      timeout: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'get_page', 'create_page', 'update_page',
              'get_descendants', 'list_spaces', 'list_pages_in_space',
              'search_cql',
              'get_footer_comments', 'get_inline_comments', 'get_comment_children',
              'create_footer_comment', 'create_inline_comment',
            ],
          },
          page_id: { type: 'string' },
          cql: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    product: 'compass',
    requiredScopes: [],
    tool: {
      name: 'atlassian_compass',
      description:
        'Manage Compass components: get, create, list, search, view activity and relationships.',
      handler: 'handlers/atlassian_compass.js',
      timeout: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'get_component', 'list_components', 'create_component',
              'get_activity', 'get_labels', 'get_types',
              'get_custom_fields', 'get_my_team_components',
              'create_relationship', 'create_custom_field',
            ],
          },
          component_id: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    product: 'jsm',
    requiredScopes: JSM_SCOPES,
    tool: {
      name: 'atlassian_jsm',
      description:
        'Manage JSM Ops: get/search alerts, on-call schedules, teams, update alert status.',
      handler: 'handlers/atlassian_jsm.js',
      timeout: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'get_alert', 'search_alerts',
              'get_schedule', 'list_schedules',
              'get_team', 'list_teams',
              'update_alert',
            ],
          },
          alert_id: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    product: 'bitbucket',
    requiredScopes: [],
    tool: {
      name: 'atlassian_bitbucket',
      description:
        'Manage Bitbucket Cloud: repos, PRs, pipelines, deployments, environments.',
      handler: 'handlers/atlassian_bitbucket.js',
      timeout: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'list_workspaces', 'get_workspace',
              'list_repos', 'get_repo', 'get_default_reviewers',
              'list_pull_requests', 'get_pull_request', 'get_pr_diff', 'get_pr_comments',
              'create_pull_request', 'merge_pull_request', 'approve_pull_request', 'comment_on_pr',
              'get_branch', 'get_commit', 'list_files',
              'create_branch', 'create_commit',
              'list_pipelines', 'get_pipeline', 'get_pipeline_steps', 'get_step_log', 'run_pipeline',
              'list_deployments', 'get_deployment',
              'list_environments', 'create_environment', 'update_environment', 'delete_environment',
              'my_pull_requests',
            ],
          },
          workspace: { type: 'string' },
          repo_slug: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    product: 'search',
    requiredScopes: [...JIRA_SCOPES, ...CONFLUENCE_SCOPES],
    tool: {
      name: 'atlassian_search',
      description:
        'Cross-product Atlassian search and Teamwork Graph. Natural language search via Rovo.',
      handler: 'handlers/atlassian_search.js',
      timeout: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'fetch', 'get_context', 'get_object', 'get_user_info', 'list_resources'],
          },
          query: { type: 'string' },
          ari: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
] as const;

// ─── Skill Class ────────────────────────────────────────────────────────

export default class AtlassianSkill extends BaseSkill {
  private enabledProducts: Set<string> = new Set();

  override async initialize(ctx: SkillContext): Promise<void> {
    await super.initialize(ctx);

    // Push auth secrets into env so handlers can read them
    // OAuth fields
    if (ctx.secrets.oauth_access_token) {
      process.env.ATLASSIAN_OAUTH_TOKEN = ctx.secrets.oauth_access_token;
    }
    if (ctx.secrets.oauth_refresh_token) {
      process.env.ATLASSIAN_REFRESH_TOKEN = ctx.secrets.oauth_refresh_token;
    }
    if (ctx.secrets.oauth_client_secret) {
      process.env.ATLASSIAN_CLIENT_SECRET = ctx.secrets.oauth_client_secret;
    }
    if (ctx.config.oauth_client_id) {
      process.env.ATLASSIAN_CLIENT_ID = String(ctx.config.oauth_client_id);
    }

    // API token fields
    if (ctx.secrets.api_token) {
      process.env.ATLASSIAN_API_TOKEN = ctx.secrets.api_token;
    }
    if (ctx.config.api_email) {
      process.env.ATLASSIAN_EMAIL = String(ctx.config.api_email);
    }

    // Common fields
    if (ctx.config.auth_method) {
      process.env.ATLASSIAN_AUTH_METHOD = String(ctx.config.auth_method);
    }
    if (ctx.config.default_cloud_id) {
      process.env.ATLASSIAN_CLOUD_ID = String(ctx.config.default_cloud_id);
    }
    if (ctx.config.mcp_endpoint) {
      process.env.ATLASSIAN_MCP_ENDPOINT = String(ctx.config.mcp_endpoint);
    }

    // Determine which products are enabled
    const defaults: Record<string, boolean> = {
      jira: true,
      confluence: true,
      compass: false,
      jsm: false,
      bitbucket: false,
      search: true,
    };

    for (const [product, defaultVal] of Object.entries(defaults)) {
      const key = `enable_${product}`;
      const enabled = key in ctx.config ? Boolean(ctx.config[key]) : defaultVal;
      if (enabled) this.enabledProducts.add(product);
    }

    ctx.logger.info('Atlassian skill configured', {
      auth: ctx.config.auth_method ?? 'oauth',
      products: [...this.enabledProducts].join(', '),
    });
  }

  override async activate(): Promise<void> {
    await super.activate();
    this.ctx.logger.info('AtlassianSkill activated', {
      products: [...this.enabledProducts].join(', '),
    });
  }

  getTools(): SkillTool[] {
    return TOOL_DEFINITIONS
      .filter((def) => this.enabledProducts.has(def.product))
      .map((def) => def.tool);
  }
}
