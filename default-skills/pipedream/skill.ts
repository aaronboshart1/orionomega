import { BaseSkill } from '@orionomega/skills-sdk';
import type { SkillTool, SkillContext } from '@orionomega/skills-sdk';

// ─── Feature → Tool Mapping ──────────────────────────────────────

interface PipedreamToolDef {
  feature: string;
  tool: SkillTool;
}

const TOOL_DEFINITIONS: readonly PipedreamToolDef[] = [
  {
    feature: 'apps',
    tool: {
      name: 'pipedream_apps',
      description:
        'Search and browse the Pipedream app catalog (3,000+ integrations). List apps, search by name, get details.',
      handler: 'handlers/pipedream_apps.js',
      timeout: 30_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list_apps', 'get_app', 'list_categories'],
          },
          query: { type: 'string' },
          app_id: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    feature: 'components',
    tool: {
      name: 'pipedream_components',
      description:
        'List and retrieve Pipedream component definitions (actions and triggers). Search and get prop schemas.',
      handler: 'handlers/pipedream_components.js',
      timeout: 30_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list_components', 'get_component', 'configure_prop', 'reload_props'],
          },
          component_key: { type: 'string' },
          query: { type: 'string' },
          app: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    feature: 'actions',
    tool: {
      name: 'pipedream_actions',
      description:
        'List, configure, and run Pipedream action components. Execute pre-built API operations on behalf of users.',
      handler: 'handlers/pipedream_actions.js',
      timeout: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list_actions', 'get_action', 'configure_prop', 'reload_props', 'run_action'],
          },
          action_key: { type: 'string' },
          external_user_id: { type: 'string' },
          configured_props: { type: 'object' },
        },
        required: ['action'],
      },
    },
  },
  {
    feature: 'triggers',
    tool: {
      name: 'pipedream_triggers',
      description:
        'Deploy, list, update, and delete Pipedream triggers. Listen for events from third-party apps.',
      handler: 'handlers/pipedream_triggers.js',
      timeout: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'list_triggers', 'get_trigger', 'configure_prop', 'reload_props',
              'deploy_trigger', 'list_deployed', 'get_deployed',
              'update_deployed', 'delete_deployed', 'get_events',
            ],
          },
          trigger_key: { type: 'string' },
          deployed_trigger_id: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    feature: 'accounts',
    tool: {
      name: 'pipedream_accounts',
      description:
        'Manage Pipedream connected accounts. List, get details, and delete OAuth/API key connections.',
      handler: 'handlers/pipedream_accounts.js',
      timeout: 30_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list_accounts', 'get_account', 'delete_account', 'delete_accounts_by_app'],
          },
          account_id: { type: 'string' },
          app: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    feature: 'users',
    tool: {
      name: 'pipedream_users',
      description:
        'Manage Pipedream Connect external users and tokens. List users, delete users, create Connect tokens.',
      handler: 'handlers/pipedream_users.js',
      timeout: 30_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list_users', 'delete_user', 'create_connect_token'],
          },
          external_user_id: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    feature: 'workflows',
    tool: {
      name: 'pipedream_workflows',
      description:
        'Invoke Pipedream workflows via HTTP trigger with user identity and custom payloads.',
      handler: 'handlers/pipedream_workflows.js',
      timeout: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['invoke_workflow'] },
          workflow_url: { type: 'string' },
          workflow_id: { type: 'string' },
          payload: { type: 'object' },
        },
        required: ['action'],
      },
    },
  },
  {
    feature: 'proxy',
    tool: {
      name: 'pipedream_proxy',
      description:
        'Route API requests through Pipedream Connect Proxy with automatic credential injection.',
      handler: 'handlers/pipedream_proxy.js',
      timeout: 45_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['proxy_request'] },
          app: { type: 'string' },
          url: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        },
        required: ['action', 'app'],
      },
    },
  },
] as const;

// ─── Skill Class ────────────────────────────────────────────────

export default class PipedreamSkill extends BaseSkill {
  private enabledFeatures: Set<string> = new Set();

  override async initialize(ctx: SkillContext): Promise<void> {
    await super.initialize(ctx);

    // Push auth secrets into env so handlers can read them
    if (ctx.secrets.oauth_client_secret) {
      process.env.PIPEDREAM_CLIENT_SECRET = ctx.secrets.oauth_client_secret;
    }
    if (ctx.secrets.oauth_access_token) {
      process.env.PIPEDREAM_ACCESS_TOKEN = ctx.secrets.oauth_access_token;
    }
    if (ctx.secrets.api_key) {
      process.env.PIPEDREAM_API_KEY = ctx.secrets.api_key;
    }

    // Push non-secret config into env
    if (ctx.config.oauth_client_id) {
      process.env.PIPEDREAM_CLIENT_ID = String(ctx.config.oauth_client_id);
    }
    if (ctx.config.project_id) {
      process.env.PIPEDREAM_PROJECT_ID = String(ctx.config.project_id);
    }
    if (ctx.config.environment) {
      process.env.PIPEDREAM_ENVIRONMENT = String(ctx.config.environment);
    }
    if (ctx.config.auth_method) {
      process.env.PIPEDREAM_AUTH_METHOD = String(ctx.config.auth_method);
    }
    if (ctx.config.default_external_user_id) {
      process.env.PIPEDREAM_EXTERNAL_USER_ID = String(ctx.config.default_external_user_id);
    }
    if (ctx.config.api_base_url) {
      process.env.PIPEDREAM_BASE_URL = String(ctx.config.api_base_url);
    }

    // Determine which features are enabled
    const defaults: Record<string, boolean> = {
      apps: true,
      components: true,
      actions: true,
      triggers: true,
      accounts: true,
      users: true,
      workflows: true,
      proxy: false,
    };

    for (const [feature, defaultVal] of Object.entries(defaults)) {
      const key = `enable_${feature}`;
      const enabled = key in ctx.config ? Boolean(ctx.config[key]) : defaultVal;
      if (enabled) this.enabledFeatures.add(feature);
    }

    ctx.logger.info('Pipedream skill configured', {
      auth: ctx.config.auth_method ?? 'oauth',
      project: ctx.config.project_id ?? '(not set)',
      environment: ctx.config.environment ?? 'development',
      features: [...this.enabledFeatures].join(', '),
    });
  }

  override async activate(): Promise<void> {
    await super.activate();
    this.ctx.logger.info('PipedreamSkill activated', {
      features: [...this.enabledFeatures].join(', '),
    });
  }

  getTools(): SkillTool[] {
    return TOOL_DEFINITIONS
      .filter((def) => this.enabledFeatures.has(def.feature))
      .map((def) => def.tool);
  }
}
