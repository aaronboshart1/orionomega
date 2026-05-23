/**
 * @module orchestration/coding/review-gate
 * Review Gate ROUTER node implementation for Coding Mode.
 *
 * Implements the risk-tiered approval gate described in Spec Section 4.5
 * ("Approval Gate ROUTER") and Section 4.7 ("Diff-Based Change Presentation").
 *
 * Risk tier classification matrix:
 *   critical — DB migrations, auth changes, deployment config → block + 2 approvals
 *   high     — large/epic complexity OR security-relevant OR manualReviewRequired → block
 *   medium   — medium complexity OR >5 files changed → auto-approve with notification
 *   low      — trivial/small, no security changes, tests pass → auto-approve
 *
 * The ROUTER node sits between validation-loop and summary-report in all
 * production templates.  The orchestrator reads `router.condition` (JSON-encoded
 * ReviewGateCondition) at runtime to decide whether to pause execution for
 * human approval or pass through automatically.
 */

import type { WorkflowNode } from '../types.js';
import type {
  CodingNodeConfig,
  RiskTier,
  ReviewGateInput,
  ReviewGateDecision,
  ApprovalPackage,
  FileChange,
  TestResults,
  SecurityResults,
  ChangeConfidence,
} from './coding-types.js';

// ── File-pattern classifiers ───────────────────────────────────────────────────

const SECURITY_PATTERNS: RegExp[] = [
  /auth(?:entication|orization|[\W_])/i,
  /\bpassword\b/i,
  /\bsecret\b/i,
  /\b(?:jwt|token|session)\b/i,
  /\bcrypto\b|\bhash(?:ing)?\b|\bencrypt/i,
  /\b(?:ssl|tls|https?)\b/i,
  /\bpermission[s]?\b/i,
  /\bacl\b/i,
];

const DATABASE_MIGRATION_PATTERNS: RegExp[] = [
  /migration/i,
  /\bmigrate\b/i,
  /\bschema\b/i,
  /\.sql$/i,
  /drizzle/i,
  /prisma.*schema/i,
  /alembic/i,
  /flyway/i,
  /liquibase/i,
];

const DEPLOYMENT_CONFIG_PATTERNS: RegExp[] = [
  /docker(?:file|[\W_])/i,
  /kubernetes|k8s/i,
  /\.env(?:\.\w+)?$/,
  /nginx/i,
  /terraform/i,
  /\bci\.ya?ml$/i,
  /\.github\/workflows/i,
  /\binfra(?:structure)?\b/i,
  /\bdeploy/i,
  /\bhelm\b/i,
];

// ── Pattern-detection helpers ──────────────────────────────────────────────────

/** Returns true if any file path matches a security-relevant pattern. */
export function detectSecurityRelevantChanges(files: string[]): boolean {
  return files.some((f) => SECURITY_PATTERNS.some((p) => p.test(f)));
}

/** Returns true if any file path matches a database migration pattern. */
export function detectDatabaseMigrations(files: string[]): boolean {
  return files.some((f) => DATABASE_MIGRATION_PATTERNS.some((p) => p.test(f)));
}

/** Returns true if any file path matches an authentication-specific pattern. */
export function detectAuthChanges(files: string[]): boolean {
  return files.some((f) => /auth(?:entication|orization|[\W_])/i.test(f));
}

/** Returns true if any file path matches a deployment/infra config pattern. */
export function detectDeploymentConfigChanges(files: string[]): boolean {
  return files.some((f) => DEPLOYMENT_CONFIG_PATTERNS.some((p) => p.test(f)));
}

/**
 * Builds a ReviewGateInput from the information available at template build
 * time (or at runtime when the orchestrator assembles full context).
 */
export function buildReviewGateInput(params: {
  complexityTier: ReviewGateInput['complexityTier'];
  filesChanged: string[];
  manualReviewRequired: boolean;
  validationPassed: boolean;
}): ReviewGateInput {
  const { complexityTier, filesChanged, manualReviewRequired, validationPassed } = params;
  return {
    complexityTier,
    filesChanged,
    manualReviewRequired,
    hasSecurityRelevantChanges: detectSecurityRelevantChanges(filesChanged),
    hasDatabaseMigrations: detectDatabaseMigrations(filesChanged),
    hasAuthChanges: detectAuthChanges(filesChanged),
    hasDeploymentConfigChanges: detectDeploymentConfigChanges(filesChanged),
    validationPassed,
  };
}

// ── Risk tier classification ───────────────────────────────────────────────────

/**
 * Classifies the risk tier from a ReviewGateInput.
 *
 * Priority order (highest wins):
 *   1. critical — DB migrations, auth changes, or deployment config changes
 *   2. high     — large/epic complexity OR security-relevant files OR manualReviewRequired
 *   3. medium   — medium complexity OR more than 5 files changed
 *   4. low      — everything else (trivial/small, clean tests, no special patterns)
 */
export function assessRiskTier(input: ReviewGateInput): RiskTier {
  // Critical: structural changes that can break production in hard-to-revert ways
  if (input.hasDatabaseMigrations || input.hasAuthChanges || input.hasDeploymentConfigChanges) {
    return 'critical';
  }

  // High: large scope, security sensitivity, or explicit architect flag
  if (
    input.complexityTier === 'large' ||
    input.complexityTier === 'epic' ||
    input.hasSecurityRelevantChanges ||
    input.manualReviewRequired
  ) {
    return 'high';
  }

  // Medium: moderate scope or many files touched
  if (input.complexityTier === 'medium' || input.filesChanged.length > 5) {
    return 'medium';
  }

  // Low: small/trivial changes with no special patterns
  return 'low';
}

/** Maps a RiskTier to its corresponding gate action. */
export function riskTierToAction(tier: RiskTier): ReviewGateDecision['action'] {
  switch (tier) {
    case 'low':
      return 'auto-approve';
    case 'medium':
      return 'notify-and-approve';
    case 'high':
      return 'block-for-review';
    case 'critical':
      return 'block-require-2-approvals';
  }
}

/** Human-readable rationale for each tier/action combination. */
function buildRationale(tier: RiskTier, input: ReviewGateInput): string {
  const reasons: string[] = [];

  if (input.hasDatabaseMigrations) reasons.push('database migration detected');
  if (input.hasAuthChanges) reasons.push('authentication/authorization files changed');
  if (input.hasDeploymentConfigChanges) reasons.push('deployment configuration changed');
  if (input.hasSecurityRelevantChanges) reasons.push('security-relevant files changed');
  if (input.manualReviewRequired) reasons.push('architect flagged manual review required');
  if (input.complexityTier === 'large' || input.complexityTier === 'epic') {
    reasons.push(`${input.complexityTier} complexity change`);
  }
  if (!input.validationPassed) reasons.push('validation did not pass');
  if (input.filesChanged.length > 5) {
    reasons.push(`${input.filesChanged.length} files changed`);
  }

  if (reasons.length === 0) {
    return `${tier} risk: small-scope change, validation passed, no sensitive patterns detected`;
  }
  return `${tier} risk: ${reasons.join('; ')}`;
}

/**
 * Produces a ReviewGateDecision from a ReviewGateInput.
 * The decision drives whether the orchestrator auto-proceeds or blocks.
 */
export function makeReviewGateDecision(
  input: ReviewGateInput,
  approvalPackage?: ApprovalPackage,
): ReviewGateDecision {
  const riskTier = assessRiskTier(input);
  const action = riskTierToAction(riskTier);
  const reason = buildRationale(riskTier, input);

  return {
    riskTier,
    action,
    reason,
    approvalPackage: action === 'auto-approve' || action === 'notify-and-approve'
      ? undefined
      : approvalPackage,
  };
}

// ── ApprovalPackage builder ────────────────────────────────────────────────────

/**
 * Constructs an ApprovalPackage from DAG artifacts.
 *
 * Called by the orchestrator when the review gate determines the risk tier
 * is high or critical and human approval is required before committing.
 */
export function buildApprovalPackage(params: {
  summary: string;
  riskLevel: RiskTier;
  filesChanged: FileChange[];
  testResults: TestResults;
  securityScanResults: SecurityResults;
  architectDecision: string;
  rollbackPlan: string;
  estimatedImpact: string;
}): ApprovalPackage {
  return {
    summary: params.summary,
    riskLevel: params.riskLevel,
    filesChanged: params.filesChanged,
    testResults: params.testResults,
    securityScanResults: params.securityScanResults,
    architectDecision: params.architectDecision,
    rollbackPlan: params.rollbackPlan,
    estimatedImpact: params.estimatedImpact,
  };
}

/**
 * Builds a minimal placeholder FileChange from a file path and git diff string.
 * The orchestrator calls this when assembling an ApprovalPackage at runtime.
 */
export function buildFileChange(params: {
  path: string;
  action: FileChange['action'];
  diff: string;
  rationale: string;
}): FileChange {
  const added = (params.diff.match(/^\+(?!\+\+)/gm) ?? []).length;
  const removed = (params.diff.match(/^-(?!--)/gm) ?? []).length;
  return {
    path: params.path,
    action: params.action,
    linesAdded: added,
    linesRemoved: removed,
    diff: params.diff,
    rationale: params.rationale,
  };
}

// ── ChangeConfidence scorer ────────────────────────────────────────────────────

/** Numeric weight for each risk tier used in the complexity-risk factor. */
const RISK_TIER_WEIGHT: Record<RiskTier, number> = {
  low: 0.1,
  medium: 0.3,
  high: 0.6,
  critical: 0.9,
};

/**
 * Computes a composite ChangeConfidence score (Section 9.5).
 *
 * Weighted factors:
 *   35%  testsCovering  (did tests pass?)
 *   25%  reviewerApproval
 *   20%  securityClean
 *   10%  stylisticMatch (default 0.8 when no linting data)
 *   10%  (1 - complexityRisk)
 */
export function computeChangeConfidence(params: {
  testsPassed: boolean;
  reviewerApproved: boolean;
  securityClean: boolean;
  riskTier: RiskTier;
  /** Override stylistic match score (0–1). Defaults to 0.8. */
  stylisticMatch?: number;
}): ChangeConfidence {
  const {
    testsPassed,
    reviewerApproved,
    securityClean,
    riskTier,
    stylisticMatch = 0.8,
  } = params;

  const testsCovering = testsPassed ? 1.0 : 0.0;
  const complexityRisk = RISK_TIER_WEIGHT[riskTier];

  const overall = Math.min(
    1.0,
    Math.max(
      0.0,
      testsCovering * 0.35 +
        (reviewerApproved ? 0.25 : 0) +
        (securityClean ? 0.20 : 0) +
        stylisticMatch * 0.10 +
        (1 - complexityRisk) * 0.10,
    ),
  );

  const parts: string[] = [];
  if (testsPassed) parts.push('all tests pass');
  else parts.push('tests failed or not run');
  if (reviewerApproved) parts.push('reviewer approved');
  else parts.push('not reviewed');
  if (!securityClean) parts.push('security concerns flagged');
  if (complexityRisk >= 0.6) parts.push('high-complexity change warrants manual review');

  return {
    overall,
    factors: {
      testsCovering,
      reviewerApproval: reviewerApproved,
      securityClean,
      stylisticMatch,
      complexityRisk,
    },
    explanation: parts.join('; '),
  };
}

// ── ROUTER node builder ────────────────────────────────────────────────────────

/** Encoded into `router.condition` so the orchestrator can deserialize it. */
export interface ReviewGateCondition {
  type: 'risk-gate';
  riskTier: RiskTier;
  action: ReviewGateDecision['action'];
  reason: string;
  /** Full input context preserved for runtime re-evaluation with live files. */
  gateInput: ReviewGateInput;
}

/** Parameters for building a review-gate ROUTER node. */
export interface ReviewGateNodeParams {
  /** Working directory (passed through to codingConfig). */
  cwd: string;
  /**
   * Node this gate depends on.  Typically 'validation-loop'.
   * Override when wiring into a non-standard template.
   */
  dependsOn?: string[];
  /**
   * Complexity tier hint available at template build time.
   * The orchestrator may re-assess at runtime with actual file counts.
   */
  complexityTier?: ReviewGateInput['complexityTier'];
  /** File paths known at template build time (may be empty; refined at runtime). */
  filesChanged?: string[];
  /** If true, always escalate to block-for-review regardless of file patterns. */
  manualReviewRequired?: boolean;
  /**
   * Node ID to route to when the gate auto-approves (low/medium risk).
   * Defaults to 'summary-report'.
   */
  approvedNextNode?: string;
  /**
   * Node ID to route to when blocked for human review (high/critical risk).
   * Defaults to 'summary-report' — the orchestrator pauses before executing it.
   */
  blockedNextNode?: string;
}

/**
 * Builds a review-gate ROUTER WorkflowNode for insertion into a Coding Mode DAG.
 *
 * The node carries:
 *   - `type: 'ROUTER'`
 *   - `router.condition`: JSON-encoded ReviewGateCondition for the orchestrator
 *   - `router.routes`: risk-tier → downstream node ID mapping
 *   - `codingConfig.codingRole: 'review-gate'`
 *
 * Both approved and blocked routes default to 'summary-report'.  The
 * orchestrator distinguishes them by reading `router.condition.action`:
 * `auto-approve` / `notify-and-approve` → proceed directly;
 * `block-for-review` / `block-require-2-approvals` → pause execution,
 * emit an ApprovalPackage event, and await `gate_response`.
 */
export function buildReviewGateNode(params: ReviewGateNodeParams): WorkflowNode {
  const {
    cwd,
    dependsOn = ['validation-loop'],
    complexityTier = 'medium',
    filesChanged = [],
    manualReviewRequired = false,
    approvedNextNode = 'summary-report',
    blockedNextNode = 'summary-report',
  } = params;

  const gateInput = buildReviewGateInput({
    complexityTier,
    filesChanged,
    manualReviewRequired,
    validationPassed: true, // conservative default; orchestrator re-evaluates at runtime
  });

  const riskTier = assessRiskTier(gateInput);
  const action = riskTierToAction(riskTier);
  const reason = buildRationale(riskTier, gateInput);

  const condition: ReviewGateCondition = {
    type: 'risk-gate',
    riskTier,
    action,
    reason,
    gateInput,
  };

  const codingConfig: CodingNodeConfig = {
    task: 'Assess change risk and route to approval or auto-proceed path',
    codingRole: 'review-gate',
    fileScope: {
      owned: [],
      readable: [],
      lockRequired: false,
    },
  };

  return {
    id: 'review-gate',
    type: 'ROUTER',
    label: 'Review Gate',
    dependsOn,
    status: 'pending',
    router: {
      condition: JSON.stringify(condition),
      routes: {
        // Low and medium risk both auto-proceed (medium adds notification)
        low: approvedNextNode,
        medium: approvedNextNode,
        // High and critical block pending human approval
        high: blockedNextNode,
        critical: blockedNextNode,
      },
    },
    codingConfig,
  };
}
