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
  // Review Gate / Approval Workflow (Phase 1 Foundation — Spec Sections 4.4, 4.5, 4.7, 9.5)
  RiskTier,
  ReviewIssue,
  ReviewResult,
  SecurityFinding,
  SecurityResults,
  FileChange,
  ApprovalPackage,
  EscalationSignal,
  ReviewGateInput,
  ReviewGateDecision,
  ChangeConfidence,
  CodingProgressEvent,
} from './coding-types.js';

// ── Review Gate ───────────────────────────────────────────────────────────────
export {
  assessRiskTier,
  riskTierToAction,
  makeReviewGateDecision,
  buildReviewGateInput,
  buildReviewGateNode,
  buildApprovalPackage,
  buildFileChange,
  computeChangeConfidence,
  detectSecurityRelevantChanges,
  detectDatabaseMigrations,
  detectAuthChanges,
  detectDeploymentConfigChanges,
} from './review-gate.js';
export type { ReviewGateNodeParams, ReviewGateCondition } from './review-gate.js';

// ── File Lock Manager ─────────────────────────────────────────────────────────
export { FileLockManager } from './file-lock-manager.js';
export type { FileLockManagerState } from './file-lock-manager.js';

// ── Output Aggregator ─────────────────────────────────────────────────────────
export { OutputAggregator } from './output-aggregator.js';

// ── Budget Allocator ──────────────────────────────────────────────────────────
export {
  CodingBudgetAllocator,
  complexityMultiplier,
  estimateTokenBudget,
  calculateTokenCost,
  MODEL_COST_RATES,
} from './coding-budget.js';
export type { NodeDescriptor, ModelCostRate } from './coding-budget.js';

// ── Model Resolver ────────────────────────────────────────────────────────────
export { CodingModelResolver } from './coding-models.js';
export type { ModelResolutionContext } from './coding-models.js';

// ── Validation Loop ───────────────────────────────────────────────────────────
export {
  ValidationLoop,
  detectValidationCommands,
  buildValidationChain,
} from './validation-loop.js';
export type {
  ValidationLoopResult,
  ValidationIteration,
  ValidationStep,
  ValidationStepKind,
} from './validation-loop.js';

// ── Test Result Parser ────────────────────────────────────────────────────────
export {
  parseJestJson,
  parsePytestJunit,
  parseGoTestJson,
  parseCargoTestJson,
  parseMochaJson,
  detectTestFramework,
  classifyFailures,
  buildDebuggerContext,
} from './test-result-parser.js';
export type {
  TestFramework,
  FailureCategory,
  FailureClassification,
  TestFailure,
  TestResults,
  TestFrameworkConfig,
  ProjectProfile,
} from './test-result-parser.js';

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
  normalizeRepoHint,
} from './coding-orchestrator.js';
export type {
  CodingOrchestratorConfig,
  CodingEventEmitters,
} from './coding-orchestrator.js';

// ── Repo Manager (session-scoped clone + worktree primitives) ────────────────
export {
  ensureSessionClone,
  addWorktree,
  removeWorktree,
  mergeBranchInto,
  repoNameFromRemoteUrl,
} from './repo-manager.js';
export { getLastCommit } from './repo-manager.js';
export type {
  EnsureSessionCloneResult,
  AddWorktreeResult,
} from './repo-manager.js';

// ── Safe Commit ───────────────────────────────────────────────────────────────
export {
  MAX_COMMITTABLE_BYTES,
  DEFAULT_GITIGNORE_ENTRIES,
  SECRET_CONTENT_PATTERNS,
  scanFileContentForSecrets,
  ensureSafeGitignore,
  findUnsafeFiles,
  prepareSafeCommit,
  findUnsafeCommittedFiles,
  installSafeCommitHooks,
  buildCommitSafetyToolGuard,
  parseGitCommandIntent,
  formatCommitSafetyMessage,
  CommitSafetyError,
} from './safe-commit.js';
export type {
  UnsafeFile,
  FindUnsafeFilesResult,
  EnsureSafeGitignoreResult,
  PrepareSafeCommitResult,
  FindUnsafeCommittedFilesResult,
  FindUnsafeCommittedFilesOptions,
  InstallSafeCommitHooksResult,
  CommitSafetyToolGuardOptions,
  ParsedGitCommandIntent,
  GitCommandKind,
} from './safe-commit.js';

// ── Agent Role Prompts ────────────────────────────────────────────────────────
export {
  AGENT_ROLE_SYSTEM_PROMPTS,
  ROLE_TOOL_PERMISSIONS,
} from './agent-role-prompts.js';
export type {
  AgentRole,
  RoleToolPermission,
} from './agent-role-prompts.js';

// ── Codebase Indexer (Section 6.1) ───────────────────────────────────────────
export {
  CodebaseIndexer,
  discoverSourceFiles,
  detectLanguage,
  extractSymbols,
  extractImports,
  resolveImportPath,
  buildDependencyGraph,
  computePageRank,
} from './codebase-indexer.js';
export type {
  SymbolInfo,
  ImportInfo,
  FileRecord,
  DependencyGraph,
  CodebaseIndex,
  SemanticIndex,
  CodebaseIndexerOptions,
} from './codebase-indexer.js';

// ── Codebase Query (Section 6.2) ──────────────────────────────────────────────
export { CodebaseQuery } from './codebase-query.js';
export type {
  SymbolLocation,
  SearchResult,
  ImpactResult,
} from './codebase-query.js';

// ── Relevance Scorer (Section 4.2) ────────────────────────────────────────────
export { computeRelevance, rankFilesByRelevance } from './relevance-scorer.js';
export type { ScoringTask } from './relevance-scorer.js';

// ── Context Loader (Section 6.4) ──────────────────────────────────────────────
export {
  buildTieredContext,
  extractFileSkeleton,
  FILE_BUDGET_PER_ROLE,
  TOKEN_BUDGET_PER_ROLE,
} from './context-loader.js';
export type { ContextEntry, TieredContext } from './context-loader.js';

// ── Git Insights (Section 4.2) ────────────────────────────────────────────────
export { analyzeGitHistory, gitCochangeFrequency } from './git-insights.js';
export type { GitInsights } from './git-insights.js';

// ── Project Fingerprint (Section 7.3) ────────────────────────────────────────
export {
  saveFingerprint,
  loadFingerprint,
  isFingerprintValid,
  loadValidFingerprint,
  buildFingerprint,
  computeFileChangeRatio,
} from './project-fingerprint.js';
export type {
  ProjectFingerprint,
  FingerprintValidity,
} from './project-fingerprint.js';

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

// ── Skill Bridge ───────────────────────────────────────────────────────────────
export {
  MCP_TOOL_SKILL_MAP,
  EXTENDED_TOOL_NAMES,
  ROLE_EXTENDED_TOOLS,
  getRequiredSkillsForRole,
  roleCanUseTool,
  buildCodebaseQueryTool,
  SkillBridge,
} from './skill-bridge.js';
export type {
  CodebaseIndexAdapter,
  CodebaseIndexLoader,
  SkillBridgeOptions,
} from './skill-bridge.js';

// ── Intent Classifier ──────────────────────────────────────────────────────────
export {
  CODING_PATTERNS,
  isCodingRequest,
  assessComplexity,
  selectMode,
  selectTemplate,
  llmClassifyIntent,
  classifyCodeIntent,
} from './intent-classifier.js';
export type {
  IntentType,
  CodingSubType,
  ComplexityTier,
  ExecutionMode,
  IntentClassification,
  ClassifyOptions,
} from './intent-classifier.js';

// ── Planning Schemas ───────────────────────────────────────────────────────────
// RiskTier, ReviewIssue, ReviewResult, FileChange, ApprovalPackage, and
// EscalationSignal are already exported from coding-types.js above.
// TestFailure and TestResults are already exported from test-result-parser.js.
// Only the genuinely new planning types are added here.
export { validatePlanningDecision } from './planning-schemas.js';
export type {
  CodingTask,
  PlanningDecision,
  PlanningViolation,
  PlanningValidationResult,
} from './planning-schemas.js';
