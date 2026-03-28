import { BaseSkill } from '@orionomega/skills-sdk';
import type { SkillTool, SkillContext } from '@orionomega/skills-sdk';

export default class WebSearchSkill extends BaseSkill {
  private defaultCount = 5;
  private maxChars = 500;
  private userAgent = '';

  override async initialize(ctx: SkillContext): Promise<void> {
    await super.initialize(ctx);
    this.defaultCount = Number(ctx.config.default_count ?? 5);
    this.maxChars = Number(ctx.config.max_chars ?? 500);
    this.userAgent = String(ctx.config.user_agent ?? '');
  }

  override async activate(): Promise<void> {
    await super.activate();
    this.ctx.logger.info('WebSearchSkill activated', {
      defaultCount: this.defaultCount,
      maxChars: this.maxChars,
      userAgent: this.userAgent || '(default)',
    });
  }

  getTools(): SkillTool[] {
    return [
      {
        name: 'web_search',
        description: 'Search the web for information. Returns titles, URLs, and snippets.',
        handler: 'handlers/web_search.js',
        timeout: 30_000,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query string',
            },
            count: {
              type: 'number',
              description: `Number of results to return (1-20, default ${this.defaultCount})`,
            },
          },
          required: ['query'],
        },
      },
    ];
  }
}
