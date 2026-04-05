/**
 * @module orchestration/coding
 * Public API for Coding Mode — re-exports all stable interfaces.
 *
 * Consumers should import from this module, not from individual sub-modules,
 * to maintain a stable public surface as internals evolve.
 */

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  CodingRole,
  CodingDAGTemplate,
  FileScope,
  CodingNodeConfig,
  ValidationConfig,
  CodingModeConfig,
  CodebaseScanOutput,
  ArchitectureDesignOutput,
  FanOutDecision,
  ImplementerOutput,
  StitcherOutput,
  ValidatorOutput,
  NodeBudget,
  BudgetAllocation,
  FileConflict,
  AggregatedOutput,
  AcquireResult,
  CodingPlannerOutput,
} from './coding-types.js';

// ── File Lock Manager ─────────────────────────────────────────────────────────
export { FileLockManager } from './file-lock-manager.js';
export type { FileLockManagerState } from './file-lock-manager.js';

// ── Output Aggregator ─────────────────────────────────────────────────────────
export { OutputAggregator } from './output-aggregator.js';

// ── Budget Allocator ──────────────────────────────────────────────────────────
export {
  CodingBudgetAllocator,
  complexityMultiplier,
  estimateMaxTurns,
  estimateTokenBudget,
} from './coding-budget.js';
export type { NodeDescriptor } from './coding-budget.js';

// ── Model Resolver ────────────────────────────────────────────────────────────
export { CodingModelResolver } from './coding-models.js';
export type { ModelResolutionContext } from './coding-models.js';

// ── Validation Loop ───────────────────────────────────────────────────────────
export {
  ValidationLoop,
  detectValidationCommands,
} from './validation-loop.js';
export type { ValidationLoopResult, ValidationIteration } from './validation-loop.js';

// ── Worker Pool ───────────────────────────────────────────────────────────────
export { CodingWorkerPool } from './coding-worker-pool.js';
export type {
  CodingWorkerPoolConfig,
  WorkerExecutorFn,
} from './coding-worker-pool.js';

// ── Planner ───────────────────────────────────────────────────────────────────
export {
  CodingPlanner,
  matchCodingIntent,
  isCodingModeRequest,
} from './coding-planner.js';
export type { CodingPlannerOptions } from './coding-planner.js';

// ── Orchestrator ──────────────────────────────────────────────────────────────
export {
  CodingOrchestrator,
  setCodingOrchestatorEmitters,
  parseCodingRequest,
} from './coding-orchestrator.js';
export type {
  CodingOrchestratorConfig,
  CodingEventEmitters,
} from './coding-orchestrator.js';

// ── Templates ─────────────────────────────────────────────────────────────────
export {
  loadCodingTemplate,
  CODING_TEMPLATE_NAMES,
  buildFeatureImplementationTemplate,
  buildBugFixTemplate,
  buildRefactorTemplate,
  buildTestSuiteTemplate,
  buildReviewIterateTemplate,
} from './templates/index.js';
export type {
  CommonTemplateParams,
  FeatureImplementationParams,
  BugFixParams,
  RefactorParams,
  TestSuiteParams,
  ReviewIterateParams,
} from './templates/index.js';
