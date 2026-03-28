export { HindsightClient } from './client.js';
export { HindsightError } from './errors.js';
export type * from './types.js';

// Memory management modules (moved from core for clean boundaries)
export { BankManager } from './bank-manager.js';
export { MentalModelManager } from './mental-models.js';
export { SessionBootstrap } from './session-bootstrap.js';
export type { BootstrapContext, SessionAnchor } from './session-bootstrap.js';
export { SelfKnowledge } from './self-knowledge.js';
export type { SelfKnowledgeConfig } from './self-knowledge.js';
export { createLogger, setLogLevel } from './logger.js';
export type { Logger, LogLevel } from './logger.js';
export { trigramSimilarity, deduplicateByContent, computeClientRelevance } from './similarity.js';
