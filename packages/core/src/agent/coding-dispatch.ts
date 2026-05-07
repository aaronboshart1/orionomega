/**
 * @module agent/coding-dispatch
 *
 * Per-run preparation for code-mode dispatches.
 *
 * `OrchestrationBridge.dispatchCodingWorkflow` calls `prepareCodingDispatch`
 * once per user message in code mode. Each call:
 *
 *   1. Mints a fresh `runId` (so follow-up messages are independent runs).
 *   2. Resolves the remote URL via {@link resolveCodingRemote} — the legacy
 *      `file://./` fallback is gone, so this raises
 *      {@link RemoteResolutionError} when nothing matches and the bridge
 *      surfaces the verbatim message to the user.
 *   3. Clones the repo into `<workspaceDir>/output/<runId>/<repoName>`.
 *      The bridge then sets that path as the executor's `codingRepoDir`
 *      override, so every CODING_AGENT node in the planned DAG inherits it
 *      as `cwd`.
 *   4. Captures the cloned `HEAD` so the implementer prompt can carry an
 *      unambiguous Repository block (remote URL, branch, checkout path,
 *      HEAD commit). The agent never has to guess where the code lives.
 *
 * The function is split out from the bridge so it can be unit-tested
 * without spinning up the planner, executor, or websocket transport.
 *
 * @see resolveCodingRemote – the resolver itself (lives in the legacy
 *   coding-orchestrator module so both code paths share it).
 * @see OrchestrationBridge.dispatchCodingWorkflow – the only production
 *   caller.
 */

import { mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  resolveCodingRemote,
  type RemoteResolutionContext,
} from '../orchestration/coding/coding-orchestrator.js';
import {
  cloneRepo as defaultCloneRepo,
  getHeadCommit as defaultGetHeadCommit,
  repoNameFromRemoteUrl,
  ensureSessionClone as defaultEnsureSessionClone,
} from '../orchestration/coding/repo-manager.js';
import {
  loadSpecReferences as defaultLoadSpecReferences,
  renderSpecPreambleBlock,
  type SpecReference,
} from './spec-loader.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('coding-dispatch');

/**
 * Task #196: Identifies a session-scoped persistent clone selected via the
 * Git tab. When `prepareCodingDispatch` receives one of these, it skips
 * the per-run `git clone` and instead calls `ensureSessionClone` against
 * `localPath` (lazy clone-or-fast-forward) so:
 *
 *   - Multi-turn coding sessions reuse one working tree instead of
 *     re-cloning into a fresh `<output>/<runId>/<repo>` directory on every
 *     message.
 *   - The clone never lands inside the gateway's process tree (which used
 *     to break `git remote get-url origin` resolution on subsequent runs).
 *   - The Git tab's selection is the single source of truth for what repo
 *     a session operates against, removing the need for a `repo:<url>`
 *     hint on every code-mode message.
 */
export interface SessionRepoSelection {
  /** Full clone URL (HTTPS or SSH). */
  remoteUrl: string;
  /** Branch to operate on. */
  branch: string;
  /** Absolute path to the persistent session clone on disk. */
  localPath: string;
}

/**
 * Inputs to {@link prepareCodingDispatch}. Every callable dependency is
 * injectable so the unit tests can run without forking `git`.
 */
export interface PrepareCodingDispatchInput {
  /** The user's raw task message — passed through to the preamble verbatim. */
  userTask: string;
  /**
   * Workspace root used to compute the per-run output directory:
   *   `<workspaceDir>/output/<runId>/<repoName>`.
   */
  workspaceDir: string;
  /**
   * Resolver context. The bridge fills in `sourceRepoDir` /
   * `defaultRemote` / `cwdForFallback` from operator config.
   */
  remote: Omit<RemoteResolutionContext, 'repoHint'> & { repoHint?: string };
  /** Optional `branch:<name>` override extracted from the user's task. */
  branch?: string;
  /**
   * Optional pre-minted runId. When omitted, a fresh hex token is used.
   * Tests inject a deterministic value; production callers omit it so each
   * dispatch gets a unique folder.
   */
  runId?: string;
  /** Injected to bypass `git clone` in unit tests. */
  cloneRepo?: typeof defaultCloneRepo;
  /** Injected to bypass `git rev-parse HEAD` in unit tests. */
  getHeadCommit?: typeof defaultGetHeadCommit;
  /** Injected so unit tests can stub `mkdirSync`. */
  mkdir?: (dir: string) => void;
  /**
   * Resolver override. Defaults to the real
   * {@link resolveCodingRemote}; tests inject a stub.
   */
  resolveRemote?: (ctx: RemoteResolutionContext) => Promise<string>;
  /**
   * Task #174: spec-reference loader. Defaults to the real
   * {@link defaultLoadSpecReferences}; tests inject a stub so they can
   * exercise the multi-phase fan-out preamble without touching disk.
   */
  loadSpecReferences?: typeof defaultLoadSpecReferences;
  /**
   * Optional workspace root used as a secondary sandbox for spec
   * lookups (in addition to the per-run checkout). Defaults to
   * `input.workspaceDir`.
   */
  specSearchRoots?: string[];
  /**
   * Task #196: Session-scoped persistent clone. When provided, the
   * dispatch skips the per-run clone and reuses `localPath` after a
   * fetch + fast-forward. Takes priority over the resolver — the
   * `remote.*` hints become unused (but harmless) for this dispatch.
   */
  sessionRepo?: SessionRepoSelection;
  /** Injected to bypass the real `ensureSessionClone` in unit tests. */
  ensureSessionClone?: typeof defaultEnsureSessionClone;
}

/** Output of {@link prepareCodingDispatch}. */
export interface PreparedCodingDispatch {
  /** Run identifier — used as the leaf of the per-run output directory. */
  runId: string;
  /** Resolved remote URL the run will operate against. */
  remoteUrl: string;
  /** Branch to check out / push to. Defaults to `'main'`. */
  branch: string;
  /** Per-run output directory: `<workspaceDir>/output/<runId>`. */
  runDir: string;
  /** Cloned working tree path: `<runDir>/<repoName>`. Always a real git repo. */
  checkoutPath: string;
  /** HEAD commit captured immediately after cloning. May be `null` on shallow weirdness. */
  headCommit: string | null;
  /** Coding-mode planner preamble, ready to feed to the planner. */
  codingTaskPreamble: string;
  /**
   * Task #174: Spec references that were pre-loaded and inlined into the
   * preamble. Empty when the user task did not reference any spec files
   * (or none could be resolved). Exposed so the bridge / tests can log
   * how many phases were detected per spec.
   */
  specs: SpecReference[];
}

/**
 * Default branch when the user doesn't include a `branch:<name>` hint.
 * Kept as a top-level constant because both the bridge and the resolver
 * use the same default and we'd rather have one place to change it.
 */
const DEFAULT_BRANCH = 'main';

/**
 * Prepare every per-run input the planner / executor needs for a code-mode
 * dispatch. Pure aside from the file-system + `git clone` side effects,
 * which are injectable for tests.
 */
export async function prepareCodingDispatch(
  input: PrepareCodingDispatchInput,
): Promise<PreparedCodingDispatch> {
  const cloneRepo = input.cloneRepo ?? defaultCloneRepo;
  const getHeadCommit = input.getHeadCommit ?? defaultGetHeadCommit;
  const mkdir = input.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const resolveRemote = input.resolveRemote ?? resolveCodingRemote;
  const loadSpecs = input.loadSpecReferences ?? defaultLoadSpecReferences;
  const ensureSessionCloneFn = input.ensureSessionClone ?? defaultEnsureSessionClone;

  // Mint a fresh runId so follow-ups are fresh runs (artifact dirs stay isolated).
  const runId = input.runId ?? randomBytes(8).toString('hex');

  let remoteUrl: string;
  let branch: string;
  let checkoutPath: string;
  let runDir: string;
  let headCommit: string | null;

  if (input.sessionRepo) {
    // Task #196: Session-scoped path. Reuse the persistent clone and skip
    // the per-run `git clone`. ensureSessionClone is idempotent — it
    // either creates the clone (first turn) or fetches + fast-forwards
    // (subsequent turns), so the agent always starts on a fresh head.
    branch = input.sessionRepo.branch || DEFAULT_BRANCH;
    remoteUrl = input.sessionRepo.remoteUrl;
    log.info('prepareCodingDispatch: using session-scoped clone', {
      remoteUrl,
      branch,
      localPath: input.sessionRepo.localPath,
      runId,
    });
    const ensured = await ensureSessionCloneFn(remoteUrl, input.sessionRepo.localPath, branch);
    checkoutPath = ensured.localPath;
    headCommit = ensured.headCommit;
    // Per-run output dir is still allocated for artifact collection — the
    // executor writes node outputs into <workspaceDir>/output/<runId> and
    // we keep that contract regardless of where the checkout lives.
    runDir = resolvePath(input.workspaceDir, 'output', runId);
    mkdir(runDir);
  } else {
    // Legacy path (no Git tab selection): resolve remote → fresh per-run clone.
    // Surfaces RemoteResolutionError verbatim. The bridge catches this and
    // turns it into a user-facing message instead of silently dropping the
    // run into the gateway's process cwd.
    remoteUrl = await resolveRemote(input.remote);
    runDir = resolvePath(input.workspaceDir, 'output', runId);
    mkdir(runDir);
    checkoutPath = await cloneRepo(remoteUrl, runDir, {
      branch: input.branch ?? DEFAULT_BRANCH,
      shallow: true,
    });
    headCommit = await getHeadCommit(checkoutPath);
    branch = input.branch ?? DEFAULT_BRANCH;
  }

  // Task #174: pre-load any `*.md` / `*.txt` / `*.spec` references in the
  // user task. The loader is best-effort — unresolved references are
  // dropped silently, so the historical no-spec preamble is still the
  // floor behaviour. When at least one spec carries ≥3 phase markers,
  // `renderSpecPreambleBlock` injects the multi-phase fan-out rule.
  const specSearchRoots = input.specSearchRoots ?? [checkoutPath, input.workspaceDir];
  let specs: SpecReference[] = [];
  try {
    specs = loadSpecs({ task: input.userTask, roots: specSearchRoots });
  } catch (err) {
    log.warn('Spec preloading failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    specs = [];
  }
  const multiPhaseCount = specs.reduce(
    (acc, s) => acc + (s.phases.length >= 3 ? 1 : 0),
    0,
  );
  if (specs.length > 0) {
    log.info('Pre-loaded spec references for planner preamble', {
      count: specs.length,
      multiPhaseCount,
      perSpec: specs.map((s) => ({
        ref: s.reference,
        phases: s.phases.length,
        complexities: s.phases.map((p) => p.estimatedComplexity),
      })),
    });
  }

  const codingTaskPreamble = buildCodingTaskPreamble({
    userTask: input.userTask,
    remoteUrl,
    branch,
    checkoutPath,
    headCommit,
    specs,
  });

  return {
    runId,
    remoteUrl,
    branch,
    runDir,
    checkoutPath,
    headCommit,
    codingTaskPreamble,
    specs,
  };
}

/**
 * Inputs to {@link buildCodingTaskPreamble}. Exported so tests can build
 * the preamble in isolation from the rest of the dispatch pipeline.
 */
export interface BuildCodingTaskPreambleInput {
  userTask: string;
  remoteUrl: string;
  branch: string;
  checkoutPath: string;
  headCommit: string | null;
  /**
   * Task #174: Pre-loaded spec references. When at least one carries
   * ≥3 phase markers, a "Multi-phase fan-out (CRITICAL)" instruction
   * block is appended that mandates one CODING_AGENT per phase, honours
   * per-phase `dependsOn`, and asks the planner to subdivide any phase
   * tagged `estimatedComplexity: high`.
   */
  specs?: SpecReference[];
}

/**
 * Build the planner preamble for a coding workflow.
 *
 * The preamble:
 *   - Embeds a Repository block (remote URL, branch, checkout path,
 *     HEAD commit) so the implementer agent never has to guess where the
 *     code is.
 *   - Pins every CODING_AGENT node's `cwd` to the per-run checkout path.
 *   - Tells the agent to use the user's task description **verbatim** as
 *     the commit message — no `feat: ...truncated...` rewriting.
 *   - Requires the commit/push step to fail the run with the verbatim
 *     git error on push failure (auth, branch protection, etc.).
 */
export function buildCodingTaskPreamble(input: BuildCodingTaskPreambleInput): string {
  const { userTask, remoteUrl, branch, checkoutPath, headCommit } = input;
  const head = headCommit ?? 'unknown';
  const specs = input.specs ?? [];
  const specBlock = renderSpecPreambleBlock(specs);
  const specSection = specBlock ? `\n\n${specBlock}\n` : '';
  return `## CODING MODE — Structured Software Engineering Workflow

You are planning a **coding workflow**. The user wants code changes made to a repository.
The repository has already been cloned into a fresh per-run output folder for you.

### Repository (clone is already prepared — DO NOT clone again)
- Remote URL: ${remoteUrl}
- Branch: ${branch}
- Checkout path (cwd for every CODING_AGENT node): ${checkoutPath}
- HEAD commit: ${head}

### Required Workflow Structure

1. **Analyze Codebase** (first node, no dependencies)
   - Use a CODING_AGENT node to scan the project structure at \`${checkoutPath}\`
   - Identify: language, framework, test framework, build system, entry points
   - Read key files (package.json, tsconfig.json, etc.) to understand the project
   - Produce a summary of the codebase architecture

2. **Implement Changes** (depends on step 1)
   - Use one or more CODING_AGENT nodes for the actual implementation
   - Parallelise independent implementation tasks where possible
   - Each CODING_AGENT gets the codebase analysis as upstream context
   - Working directory MUST be: \`${checkoutPath}\`
   - Use Read, Write, Edit, Bash, Glob, Grep tools

3. **Test & Validate** (depends on step 2)
   - Use a CODING_AGENT node to run the project's test suite and build
   - Run: build/compile, lint, type-check, unit tests
   - Report results clearly (pass/fail with details)
   - Working directory: \`${checkoutPath}\`

4. **Commit & Push** (depends on step 3, LAST node)
   - Use a CODING_AGENT node to stage, commit, and push changes
   - Commit message: use the user's task description (the section under "### User's Task") **verbatim** as the commit message body — do NOT prefix with \`feat:\`, do NOT truncate, do NOT paraphrase.
   - Push to the remote repository: \`${remoteUrl}\` branch \`${branch}\`
   - If \`git push\` fails for ANY reason (auth, branch protection, rejected non-fast-forward, network error), the agent MUST exit with a non-zero status and surface the **verbatim** \`git push\` stderr — do NOT swallow the error and do NOT try to "fix" it by force-pushing or rewriting history. The orchestrator will fail the entire run with that error message so the user can fix the underlying problem (credentials, permissions, branch).
   - Working directory: \`${checkoutPath}\`
   - Use \`git add -A && git commit -F <(cat <<'EOF'\\n…task description…\\nEOF) && git push origin ${branch}\` (or equivalent)

### Critical Rules for Coding Mode
- ALL CODING_AGENT nodes MUST set \`cwd\` to \`${checkoutPath}\`. The orchestrator also enforces this at the executor level as a defense-in-depth, but you must still set it explicitly so the planner output is self-describing.
- Do NOT clone the repo again — it is already at \`${checkoutPath}\` (HEAD ${head.slice(0, 8)}).
- Do NOT \`cd\` to any other directory and do NOT open any other working tree.
- Use CODING_AGENT (not AGENT) for all coding tasks — they get the full Claude Code toolset.
- The workflow MUST start with codebase analysis and end with commit & push.
- Prefer LOOP nodes for build-test-fix cycles if the implementation is complex.
- Maximise parallelism for independent implementation sub-tasks.

### User's Task
${userTask}${specSection}`;
}
