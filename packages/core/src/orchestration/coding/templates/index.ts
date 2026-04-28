/**
 * @module orchestration/coding/templates/index
 * Template registry — maps CodingDAGTemplate identifiers to builder functions.
 */

import type { CodingDAGTemplate } from '../coding-types.js';
import type { WorkflowNode } from '../../types.js';

import {
  buildFeatureImplementationTemplate,
  type FeatureImplementationParams,
} from './feature-implementation.js';
import { buildBugFixTemplate, type BugFixParams } from './bug-fix.js';
import { buildRefactorTemplate, type RefactorParams } from './refactor.js';
import { buildTestSuiteTemplate, type TestSuiteParams } from './test-suite.js';
import {
  buildReviewIterateTemplate,
  type ReviewIterateParams,
} from './review-iterate.js';

// Re-export individual builders and param types
export {
  buildFeatureImplementationTemplate,
  buildBugFixTemplate,
  buildRefactorTemplate,
  buildTestSuiteTemplate,
  buildReviewIterateTemplate,
};
export type {
  FeatureImplementationParams,
  BugFixParams,
  RefactorParams,
  TestSuiteParams,
  ReviewIterateParams,
};

// ── Shared parameter shape (common across all templates) ─────────────────────

export interface CommonTemplateParams {
  task: string;
  cwd: string;
  /** Model IDs resolved by CodingModelResolver. */
  models: Record<string, string>;
  /** Per-node budget in USD. */
  budgets: Record<string, number>;
  /** Per-node max turns. */
  maxTurns: Record<string, number>;
  /** Validation commands. Empty = auto-detect. */
  validationCommands?: string[];
  validationMaxRetries?: number;
  /**
   * Per-command wall-clock budget (ms) for validation steps. Sourced from
   * `orchestration.validationTimeout` in the user's config; passed through
   * to the underlying templates that need it.
   */
  validationTimeoutMs?: number;
}

// ── Template loader ───────────────────────────────────────────────────────────

/**
 * Loads and instantiates the workflow nodes for a given Coding Mode template.
 *
 * @param template - Which template to instantiate.
 * @param params - Common template parameters.
 * @returns Array of WorkflowNode definitions.
 */
export function loadCodingTemplate(
  template: CodingDAGTemplate,
  params: CommonTemplateParams,
): WorkflowNode[] {
  const {
    task,
    cwd,
    models,
    budgets,
    maxTurns,
    validationCommands,
    validationMaxRetries,
    validationTimeoutMs,
  } = params;

  switch (template) {
    case 'feature-implementation':
      return buildFeatureImplementationTemplate({
        task,
        cwd,
        models: {
          scanner:     models.scanner     ?? models.default ?? '',
          architect:   models.architect   ?? models.default ?? '',
          implementer: models.implementer ?? models.default ?? '',
          stitcher:    models.stitcher    ?? models.default ?? '',
          testWriter:  models.testWriter  ?? models.default ?? '',
          reporter:    models.reporter    ?? models.default ?? '',
        },
        budgets: {
          scanner:     budgets.scanner     ?? 0.10,
          architect:   budgets.architect   ?? 0.30,
          implementer: budgets.implementer ?? 0.60,
          stitcher:    budgets.stitcher    ?? 0.40,
          testWriter:  budgets.testWriter  ?? 0.50,
          reporter:    budgets.reporter    ?? 0.05,
        },
        maxTurns: {
          scanner:     maxTurns.scanner     ?? 10,
          architect:   maxTurns.architect   ?? 15,
          implementer: maxTurns.implementer ?? 30,
          stitcher:    maxTurns.stitcher    ?? 20,
          testWriter:  maxTurns.testWriter  ?? 25,
          reporter:    maxTurns.reporter    ?? 5,
        },
        validationCommands,
        validationMaxRetries,
        validationTimeoutMs,
      } as FeatureImplementationParams);

    case 'bug-fix':
      return buildBugFixTemplate({
        task,
        cwd,
        models: {
          scanner:     models.scanner  ?? models.default ?? '',
          rootCause:   models.architect ?? models.default ?? '',
          fixer:       models.implementer ?? models.default ?? '',
          testWriter:  models.testWriter ?? models.default ?? '',
          reporter:    models.reporter ?? models.default ?? '',
        },
        budgets: {
          scanner:     budgets.scanner   ?? 0.10,
          rootCause:   budgets.architect ?? 0.20,
          fixer:       budgets.implementer ?? 0.50,
          testWriter:  budgets.testWriter ?? 0.30,
          reporter:    budgets.reporter   ?? 0.05,
        },
        maxTurns: {
          scanner:     maxTurns.scanner    ?? 10,
          rootCause:   maxTurns.architect  ?? 15,
          fixer:       maxTurns.implementer ?? 25,
          testWriter:  maxTurns.testWriter  ?? 15,
          reporter:    maxTurns.reporter    ?? 5,
        },
        validationCommands,
        validationMaxRetries,
        validationTimeoutMs,
      } as BugFixParams);

    case 'refactor':
      return buildRefactorTemplate({
        task,
        cwd,
        models: {
          scanner:     models.scanner     ?? models.default ?? '',
          analyst:     models.architect   ?? models.default ?? '',
          refactorer:  models.implementer ?? models.default ?? '',
          stitcher:    models.stitcher    ?? models.default ?? '',
          testUpdater: models.testWriter  ?? models.default ?? '',
          reporter:    models.reporter    ?? models.default ?? '',
        },
        budgets: {
          scanner:     budgets.scanner     ?? 0.10,
          analyst:     budgets.architect   ?? 0.20,
          refactorer:  budgets.implementer ?? 0.50,
          stitcher:    budgets.stitcher    ?? 0.30,
          testUpdater: budgets.testWriter  ?? 0.30,
          reporter:    budgets.reporter    ?? 0.05,
        },
        maxTurns: {
          scanner:     maxTurns.scanner     ?? 10,
          analyst:     maxTurns.architect   ?? 15,
          refactorer:  maxTurns.implementer ?? 30,
          stitcher:    maxTurns.stitcher    ?? 20,
          testUpdater: maxTurns.testWriter  ?? 20,
          reporter:    maxTurns.reporter    ?? 5,
        },
        validationCommands,
        validationMaxRetries,
        validationTimeoutMs,
      } as RefactorParams);

    case 'test-suite':
      return buildTestSuiteTemplate({
        task,
        cwd,
        models: {
          scanner:          models.scanner   ?? models.default ?? '',
          coverageAnalyst:  models.architect ?? models.default ?? '',
          testGen:          models.testWriter ?? models.implementer ?? models.default ?? '',
          integrator:       models.stitcher  ?? models.default ?? '',
          reporter:         models.reporter  ?? models.default ?? '',
        },
        budgets: {
          scanner:         budgets.scanner    ?? 0.10,
          coverageAnalyst: budgets.architect  ?? 0.15,
          testGen:         budgets.testWriter ?? budgets.implementer ?? 0.50,
          integrator:      budgets.stitcher   ?? 0.20,
          reporter:        budgets.reporter   ?? 0.05,
        },
        maxTurns: {
          scanner:         maxTurns.scanner    ?? 10,
          coverageAnalyst: maxTurns.architect  ?? 12,
          testGen:         maxTurns.testWriter ?? maxTurns.implementer ?? 25,
          integrator:      maxTurns.stitcher   ?? 15,
          reporter:        maxTurns.reporter   ?? 5,
        },
        validationCommands,
        validationMaxRetries,
        validationTimeoutMs,
      } as TestSuiteParams);

    case 'review-iterate':
      return buildReviewIterateTemplate({
        task,
        cwd,
        models: {
          scanner:  models.scanner   ?? models.default ?? '',
          reviewer: models.reviewer  ?? models.architect ?? models.default ?? '',
          fixer:    models.implementer ?? models.default ?? '',
          reporter: models.reporter  ?? models.default ?? '',
        },
        budgets: {
          scanner:  budgets.scanner    ?? 0.10,
          reviewer: budgets.reviewer   ?? budgets.architect ?? 0.30,
          fixer:    budgets.implementer ?? 0.50,
          reporter: budgets.reporter   ?? 0.05,
        },
        maxTurns: {
          scanner:  maxTurns.scanner    ?? 10,
          reviewer: maxTurns.reviewer   ?? maxTurns.architect ?? 20,
          fixer:    maxTurns.implementer ?? 25,
          reporter: maxTurns.reporter   ?? 5,
        },
        validationCommands,
        validationMaxRetries,
        validationTimeoutMs,
      } as ReviewIterateParams);

    default: {
      const exhaustive: never = template;
      throw new Error(`Unknown coding template: ${exhaustive as string}`);
    }
  }
}

/** All available template names. */
export const CODING_TEMPLATE_NAMES: CodingDAGTemplate[] = [
  'feature-implementation',
  'bug-fix',
  'refactor',
  'test-suite',
  'review-iterate',
];
