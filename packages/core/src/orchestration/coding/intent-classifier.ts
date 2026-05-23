/**
 * @module orchestration/coding/intent-classifier
 * Three-level intent classification pipeline for Coding Mode.
 *
 * Level 1 — Explicit mode:   agentMode='code' bypass (sub-1ms)
 * Level 2 — Regex fast-path: CODING_PATTERNS array (sub-10ms)
 * Level 3 — LLM classifier:  haiku fallback for CODE/CHAT/ORCHESTRATE (<2s)
 *
 * Also provides:
 *   - Complexity assessment (Trivial / Small / Medium / Large / Epic)
 *   - Automatic execution mode selection
 *     (quick-edit / targeted-fix / full-orchestration)
 *   - selectTemplate() mapping intent types to DAG template IDs
 *
 * See spec Section 4.1 — Request Intake & Classification.
 */

import type { AnthropicClient } from '../../anthropic/client.js';
import type { CodingDAGTemplate } from './coding-types.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('intent-classifier');

// ── Level 2 — Regex Fast-Path ─────────────────────────────────────────────────

/**
 * Regex patterns for coding intent detection (Level 2 fast-path).
 * Checked in order by `isCodingModeRequest()`; first match wins.
 *
 * From spec Section 4.1:
 * ```
 * const CODING_PATTERNS = [
 *   /\b(fix|bug|error|crash|broken)\b/i,
 *   /\b(implement|add|create|build|feature)\b/i,
 *   /\b(refactor|rename|restructure|move)\b/i,
 *   /\b(test|spec|coverage)\b/i,
 *   /\b(review|audit|check)\b/i,
 *   /\b(deploy|release|publish)\b/i,
 * ];
 * ```
 */
export const CODING_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(fix|bug|error|crash|broken)\b/i,
  /\b(implement|add|create|build|feature)\b/i,
  /\b(refactor|rename|restructure|move)\b/i,
  /\b(test|spec|coverage)\b/i,
  /\b(review|audit|check)\b/i,
  /\b(deploy|release|publish)\b/i,
] as const;

/**
 * Fast check: does the task string match any CODING_PATTERNS?
 * Used by the Level 2 path before invoking the LLM.
 *
 * @param task - Natural language task description.
 * @returns true if any pattern matches, false otherwise.
 */
export function isCodingRequest(task: string): boolean {
  return CODING_PATTERNS.some((p) => p.test(task));
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** Canonical intent type (from Level 3 LLM or inferred from Level 2). */
export type IntentType = 'CODE' | 'CHAT' | 'ORCHESTRATE';

/**
 * Sub-classification of a coding intent.
 * Maps 1-to-1 with the five DAG templates.
 */
export type CodingSubType =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'test'
  | 'review'
  | 'deploy';

/**
 * Complexity tier for a coding request.
 *
 * | Tier    | Criteria                                       | Template           | Max Workers |
 * |---------|------------------------------------------------|--------------------|-------------|
 * | trivial | Single function/method, <20 LOC change         | single-file-edit   | 1           |
 * | small   | 1-3 files, clear scope                         | bug-fix            | 2           |
 * | medium  | 3-10 files, defined feature                    | feature-impl       | 4           |
 * | large   | 10-30 files, cross-cutting concern             | feature-impl       | 8           |
 * | epic    | 30+ files or multi-phase spec                  | macro-pipeline     | 8           |
 */
export type ComplexityTier = 'trivial' | 'small' | 'medium' | 'large' | 'epic';

/**
 * Execution mode determined by the classifier.
 *
 * | Mode                | Condition                                |
 * |---------------------|------------------------------------------|
 * | quick-edit          | trivial complexity                       |
 * | targeted-fix        | small complexity + bugfix sub-type       |
 * | full-orchestration  | everything else                          |
 */
export type ExecutionMode = 'quick-edit' | 'targeted-fix' | 'full-orchestration';

/** Full result of the three-level classification pipeline. */
export interface IntentClassification {
  /** Whether the task is a coding request (not chat or generic orchestration). */
  isCoding: boolean;
  /** Top-level intent type. */
  type: IntentType;
  /** Coding sub-type (present when isCoding=true). */
  codingType?: CodingSubType;
  /** Estimated complexity tier. */
  complexity: ComplexityTier;
  /** Selected execution mode. */
  mode: ExecutionMode;
  /** Selected DAG template ID. */
  template: CodingDAGTemplate;
  /** Which classification path was taken. */
  classifiedBy: 'explicit' | 'regex' | 'llm';
}

// ── Complexity Assessment ─────────────────────────────────────────────────────

// Signals for each tier — checked top-down, first match wins.
// Each set is ordered most-specific first to avoid false positives.
const EPIC_SIGNALS: ReadonlyArray<RegExp> = [
  /\b(entire|whole|all|every|complete|full|across\s+the)\b.{0,40}\b(codebase|system|platform|app)\b/i,
  /\b(migrate|migration|rewrite|redesign|overhaul)\s+(the\s+)?entire\b/i,
  /\b(multi[- ]?phase|phase[s\s]+\d|big\s+refactor|epic)\b/i,
  /\b30\+?\s*files?\b/i,
];

const LARGE_SIGNALS: ReadonlyArray<RegExp> = [
  /\b(cross[- ]cutting|throughout|everywhere|all\s+(modules?|services?|components?))\b/i,
  /\b(1[0-9]|2[0-9])\s*files?\b/i,
  /\b(major\s+refactor|large\s+(feature|change|update))\b/i,
];

const TRIVIAL_SIGNALS: ReadonlyArray<RegExp> = [
  /\b(typo|rename\s+a?\s*(single\s+)?(variable|function|method|field|constant))\b/i,
  /\b(change\s+(the\s+)?(name|message|text|label|constant|string))\b/i,
  /\bsingle\s+(function|method|line|statement|field)\b/i,
];

const MEDIUM_SIGNALS: ReadonlyArray<RegExp> = [
  /\b(feature|endpoint|component|module|service|controller|handler)\b/i,
  /\b[3-9]\s*files?\b/i,
];

/**
 * Estimates the complexity tier from the task description.
 *
 * This is a fast heuristic; the codebase scanner profile refines it later
 * (e.g. via actual file count from `ProjectFingerprint`).
 *
 * @param task - Natural language task description.
 * @returns Estimated complexity tier.
 */
export function assessComplexity(task: string): ComplexityTier {
  for (const p of EPIC_SIGNALS)    if (p.test(task)) return 'epic';
  for (const p of LARGE_SIGNALS)   if (p.test(task)) return 'large';
  for (const p of TRIVIAL_SIGNALS) if (p.test(task)) return 'trivial';
  for (const p of MEDIUM_SIGNALS)  if (p.test(task)) return 'medium';
  return 'small';
}

// ── Execution Mode Selection ──────────────────────────────────────────────────

/**
 * Selects the execution mode from a partial IntentClassification.
 *
 * From spec Section 4.1:
 * ```typescript
 * function selectMode(intent: IntentClassification): ExecutionMode {
 *   if (intent.complexity === 'trivial') return 'quick-edit';
 *   if (intent.complexity === 'small' && intent.type === 'bugfix') return 'targeted-fix';
 *   return 'full-orchestration';
 * }
 * ```
 *
 * @param intent - Partial classification containing complexity and codingType.
 * @returns The execution mode.
 */
export function selectMode(
  intent: Pick<IntentClassification, 'complexity' | 'codingType'>,
): ExecutionMode {
  if (intent.complexity === 'trivial') return 'quick-edit';
  if (intent.complexity === 'small' && intent.codingType === 'bugfix') return 'targeted-fix';
  return 'full-orchestration';
}

// ── Template Selector ─────────────────────────────────────────────────────────

/**
 * Maps a coding intent sub-type to the corresponding DAG template ID.
 *
 * From spec Section 4.3 / Appendix B:
 *
 * | Trigger keywords                              | Template               |
 * |-----------------------------------------------|------------------------|
 * | "fix", "bug", "error", "crash"                | bug-fix                |
 * | "refactor", "rename", "restructure", "move"   | refactor               |
 * | "test", "spec", "coverage"                    | test-suite             |
 * | "review", "audit", "check"                    | review-iterate         |
 * | "implement", "add", "create", "build"         | feature-implementation |
 * | epic complexity                               | feature-implementation  |
 * |   (macro-pipeline is a future template;       |                        |
 * |    feature-implementation handles epics now)  |                        |
 *
 * @param intent - Partial classification with codingType and complexity.
 * @returns The selected DAG template ID.
 */
export function selectTemplate(
  intent: Pick<IntentClassification, 'codingType' | 'complexity'>,
): CodingDAGTemplate {
  // Epic tasks use feature-implementation today; macro-pipeline is future (Phase 4).
  // feature-implementation with the architect's MACRO_NODE expansion handles epics.
  if (intent.complexity === 'epic') return 'feature-implementation';

  switch (intent.codingType) {
    case 'bugfix':   return 'bug-fix';
    case 'refactor': return 'refactor';
    case 'test':     return 'test-suite';
    case 'review':   return 'review-iterate';
    case 'deploy':   return 'feature-implementation';
    case 'feature':  return 'feature-implementation';
    default:         return 'feature-implementation';
  }
}

// ── Level 2 Sub-Type Classifier ───────────────────────────────────────────────

/**
 * Classifies the coding sub-type from the task text using regex.
 * Returns null if no pattern matches (requires Level 3 or defaults to 'feature').
 *
 * Pattern order matters: more-specific patterns first.
 */
function regexSubType(task: string): CodingSubType | null {
  if (/\b(fix|bug|error|crash|broken|exception|failing|doesn'?t\s+work|not\s+working)\b/i.test(task)) return 'bugfix';
  if (/\b(refactor|restructure|reorganize|rename|move|extract|split|clean\s*up)\b/i.test(task))       return 'refactor';
  if (/\b(test|tests|testing|coverage|spec|specs|unit\s+test|integration\s+test)\b/i.test(task))      return 'test';
  if (/\b(review|pr|pull\s+request|audit|feedback|comment|quality)\b/i.test(task))                   return 'review';
  if (/\b(deploy|release|publish|ship)\b/i.test(task))                                                return 'deploy';
  if (/\b(implement|add|create|build|develop|feature|endpoint|component|module)\b/i.test(task))       return 'feature';
  return null;
}

// ── Level 3 LLM Classifier ────────────────────────────────────────────────────

/**
 * System prompt for the Level 3 haiku-based intent classifier.
 * Kept short to minimise token cost — haiku understands concise prompts well.
 */
const LLM_CLASSIFY_SYSTEM =
  'You are an intent classifier for an AI coding assistant.\n' +
  'Classify the user message as exactly one of:\n' +
  '- CODE: Requests to write, fix, refactor, test, review, or otherwise change code.\n' +
  '- CHAT: Conversational messages, questions, greetings, explanations that need no code changes.\n' +
  '- ORCHESTRATE: Multi-step workflows combining coding with research, deployment, or external actions.\n' +
  '\n' +
  'Respond with ONLY the word CODE, CHAT, or ORCHESTRATE.';

/**
 * Level 3 LLM fallback classifier.
 *
 * Invokes haiku to classify the task as CODE, CHAT, or ORCHESTRATE.
 * Falls back to CODE on errors (conservative: prefer over-classifying as coding).
 *
 * @param task       - Natural language task description.
 * @param client     - AnthropicClient instance.
 * @param haikuModel - Haiku model ID to use for classification.
 * @returns 'CODE', 'CHAT', or 'ORCHESTRATE'.
 */
export async function llmClassifyIntent(
  task: string,
  client: AnthropicClient,
  haikuModel: string,
): Promise<IntentType> {
  try {
    const response = await client.createMessage({
      model: haikuModel,
      maxTokens: 10,
      system: LLM_CLASSIFY_SYSTEM,
      messages: [{ role: 'user', content: task }],
    });

    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text.trim().toUpperCase())
      .join('');

    if (text.startsWith('CODE'))        return 'CODE';
    if (text.startsWith('ORCHESTRATE')) return 'ORCHESTRATE';
    if (text.startsWith('CHAT'))        return 'CHAT';

    // Unexpected response — log and default to CODE
    log.warn(`llmClassifyIntent: unexpected model response "${text.slice(0, 20)}"; defaulting to CODE`);
    return 'CODE';
  } catch (err) {
    log.warn(
      `llmClassifyIntent: classification failed (${err instanceof Error ? err.message : String(err)}); defaulting to CODE`,
    );
    return 'CODE';
  }
}

// ── Main Classification Pipeline ──────────────────────────────────────────────

/** Options for the classifyCodeIntent() pipeline. */
export interface ClassifyOptions {
  /**
   * Level 1: if true, bypass all classification and treat as an explicit
   * code-mode request (e.g. user selected "Code" mode in the UI or
   * agentMode='code' was set programmatically).
   */
  explicitCodeMode?: boolean;
  /**
   * Level 3: AnthropicClient to use for LLM fallback classification.
   * When absent, Level 3 is skipped and the task is treated as non-coding
   * when no regex match was found in Level 2.
   */
  llmClient?: AnthropicClient;
  /**
   * Level 3: Haiku model ID for the LLM classifier.
   * Required when llmClient is provided.
   */
  haikuModel?: string;
}

/**
 * Three-level intent classification pipeline.
 *
 * Runs the following stages in order, stopping as soon as a result is found:
 *
 * **Level 1 — Explicit mode (agentMode='code'):**
 *   When `opts.explicitCodeMode` is true, the input is treated as a coding
 *   request unconditionally. Sub-type is inferred via regex; complexity is
 *   estimated; template is selected. Classification path = 'explicit'.
 *
 * **Level 2 — Regex fast-path:**
 *   Matches `CODING_PATTERNS` against the task text. Provides sub-10ms
 *   classification without LLM calls. Classification path = 'regex'.
 *
 * **Level 3 — LLM classifier (haiku):**
 *   When no regex match is found and an LLM client is provided, invokes haiku
 *   to classify as CODE / CHAT / ORCHESTRATE. Classification path = 'llm'.
 *
 * If none of the above match, returns isCoding=false with type='CHAT'.
 *
 * @param task - Natural language task description.
 * @param opts - Pipeline configuration.
 * @returns Full IntentClassification.
 */
export async function classifyCodeIntent(
  task: string,
  opts: ClassifyOptions = {},
): Promise<IntentClassification> {
  // ── Level 1: Explicit mode bypass ──────────────────────────────────────────
  if (opts.explicitCodeMode) {
    const codingType = regexSubType(task) ?? 'feature';
    const complexity = assessComplexity(task);
    const mode = selectMode({ complexity, codingType });
    const template = selectTemplate({ codingType, complexity });
    log.debug(
      `classifyCodeIntent[L1]: explicit → subtype=${codingType} complexity=${complexity} template=${template}`,
    );
    return {
      isCoding: true,
      type: 'CODE',
      codingType,
      complexity,
      mode,
      template,
      classifiedBy: 'explicit',
    };
  }

  // ── Level 2: Regex fast-path ───────────────────────────────────────────────
  const codingType = regexSubType(task);
  if (codingType !== null) {
    const complexity = assessComplexity(task);
    const mode = selectMode({ complexity, codingType });
    const template = selectTemplate({ codingType, complexity });
    log.debug(
      `classifyCodeIntent[L2]: regex → subtype=${codingType} complexity=${complexity} template=${template}`,
    );
    return {
      isCoding: true,
      type: 'CODE',
      codingType,
      complexity,
      mode,
      template,
      classifiedBy: 'regex',
    };
  }

  // ── Level 3: LLM fallback ──────────────────────────────────────────────────
  if (opts.llmClient && opts.haikuModel) {
    const intentType = await llmClassifyIntent(task, opts.llmClient, opts.haikuModel);
    const isCoding = intentType === 'CODE';
    const resolvedSubType = isCoding ? (regexSubType(task) ?? 'feature') : undefined;
    const complexity = isCoding ? assessComplexity(task) : 'small';
    const mode = isCoding
      ? selectMode({ complexity, codingType: resolvedSubType })
      : 'full-orchestration';
    const template = isCoding
      ? selectTemplate({ codingType: resolvedSubType, complexity })
      : 'feature-implementation';
    log.debug(
      `classifyCodeIntent[L3]: llm → type=${intentType} subtype=${resolvedSubType ?? 'n/a'} complexity=${complexity}`,
    );
    return {
      isCoding,
      type: intentType,
      codingType: resolvedSubType,
      complexity,
      mode,
      template,
      classifiedBy: 'llm',
    };
  }

  // ── No match: treat as non-coding ─────────────────────────────────────────
  log.debug(`classifyCodeIntent: no match (no LLM client provided) → CHAT`);
  return {
    isCoding: false,
    type: 'CHAT',
    complexity: 'small',
    mode: 'full-orchestration',
    template: 'feature-implementation',
    classifiedBy: 'regex',
  };
}
