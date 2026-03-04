/**
 * @module anthropic
 * Anthropic API integration: client, tools, and agent loop.
 */

// Client
export { AnthropicClient } from './client.js';
export type {
  AnthropicMessage,
  ContentBlock,
  ToolDefinition,
  AnthropicStreamEvent,
  CreateMessageOptions,
  MessageResponse,
} from './client.js';

// Tools
export { getBuiltInTools } from './tools.js';
export type { BuiltInTool, ToolContext } from './tools.js';

// Agent loop
export { runAgentLoop } from './agent-loop.js';
export type { AgentLoopOptions, AgentLoopResult } from './agent-loop.js';
