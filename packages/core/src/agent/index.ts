/**
 * @module agent
 * Main agent module — conversational handler and prompt assembly.
 */

export type { MainAgentConfig, MainAgentCallbacks } from './main-agent.js';
export { MainAgent } from './main-agent.js';

export type { PromptContext } from './prompt-builder.js';
export { buildSystemPrompt } from './prompt-builder.js';
