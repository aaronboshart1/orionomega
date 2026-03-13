export { MainAgent } from './main-agent.js';
export type { MainAgentConfig, MainAgentCallbacks } from './main-agent.js';

export { MemoryBridge } from './memory-bridge.js';
export type { MemoryConfig } from './memory-bridge.js';

export { OrchestrationBridge } from './orchestration-bridge.js';
export type { OrchestrationConfig } from './orchestration-bridge.js';

export {
  classifyIntent,
  isImmediateExecution,
  isFastConversational,
  isFastTask,
  isOrchestrateRequest,
  isGuardedRequest,
  streamConversation,
  executeMainTool,
} from './conversation.js';
export type { IntentType } from './conversation.js';

// Re-export prompt builder (existing module)
export { buildSystemPrompt } from './prompt-builder.js';
export type { PromptContext } from './prompt-builder.js';
