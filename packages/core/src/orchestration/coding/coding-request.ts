/**
 * @module orchestration/coding/coding-request
 *
 * Pure request-parsing helpers for code-mode dispatches (Task #237 split out
 * of `coding-orchestrator.ts`). These turn a free-form user task string into a
 * structured `{ repoUrl, branch, taskDescription }` and normalize repo hints
 * into clone-able URLs. No I/O, no orchestrator state — trivially unit-testable.
 *
 * Re-exported from `coding-orchestrator.ts` so existing import paths keep
 * working (`parseCodingRequest`, `normalizeRepoHint`).
 */

/**
 * Normalize a user-supplied repo hint into a clone-able URL.
 *
 * Accepts:
 *   - Full URLs (`https://`, `http://`, `ssh://`, `git://`, `git@host:…`,
 *     `file://`) — returned as-is after stripping trailing punctuation.
 *   - Bare GitHub slugs (`owner/repo`) — expanded to
 *     `https://github.com/owner/repo.git`. This covers the common case
 *     where a user types "the repo is aaronboshart1/orionomega" and
 *     expects the system to figure out it's a GitHub repo.
 *   - GitHub HTTPS URLs missing the trailing `.git` — `.git` is appended
 *     so `git clone` doesn't follow GitHub's redirect dance.
 *
 * Trailing punctuation (`.`, `,`, `;`, `:`, `!`, `?`, `)`, `]`) is
 * stripped because conversational hints like "the repo is foo/bar."
 * would otherwise capture the period into the slug.
 *
 * Returns `undefined` for empty / whitespace-only input.
 */
export function normalizeRepoHint(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let v = raw.trim().replace(/[.,;:!?)\]]+$/, '');
  if (v.length === 0) return undefined;

  // Strip surrounding quotes / backticks.
  if ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'")) ||
      (v.startsWith('`') && v.endsWith('`'))) {
    v = v.slice(1, -1).trim();
    if (v.length === 0) return undefined;
  }

  // Already a full URL or scp-like SSH form (`git@github.com:owner/repo.git`).
  if (/^(https?|ssh|git|file):\/\//i.test(v) || /^[\w.-]+@[^:]+:/.test(v)) {
    // Append .git to GitHub HTTPS URLs that lack it so the clone path is
    // unambiguous. Other hosts vary, so leave them alone.
    if (/^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+$/i.test(v) && !/\.git$/i.test(v)) {
      return `${v}.git`;
    }
    return v;
  }

  // Bare slug `owner/repo` (one slash, GitHub-style identifier on both
  // sides) → assume GitHub HTTPS clone URL.
  if (/^[\w.-]+\/[\w.-]+$/.test(v)) {
    return `https://github.com/${v}.git`;
  }

  return v;
}

/**
 * Quick syntactic test: does this raw token *look like* a repo reference
 * (URL, scp-like SSH, or `owner/repo` slug) once trailing punctuation is
 * stripped? Used by {@link parseCodingRequest} to reject false positives
 * from loose conversational patterns ("clone the repo" must NOT capture
 * "the" as a repo, "the default branch is main" must NOT capture "main"
 * via a non-existent loose branch pattern).
 */
export function looksLikeRepoToken(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().replace(/[.,;:!?)\]]+$/, '').replace(/^["'`]|["'`]$/g, '');
  if (v.length === 0) return false;
  if (/^(https?|ssh|git|file):\/\//i.test(v)) return true;
  if (/^[\w.-]+@[^:]+:/.test(v)) return true; // git@github.com:foo/bar.git
  if (/^[\w.-]+\/[\w.-]+$/.test(v)) return true; // owner/repo slug
  return false;
}

export interface ParsedCodingRequest {
  repoUrl: string | undefined;
  branch: string;
  taskDescription: string;
}

/**
 * Extract a `{ repoUrl, branch, taskDescription }` triple from a free-form
 * coding task string. Repo and branch hints are matched in priority order;
 * loose conversational matches are validated against {@link looksLikeRepoToken}
 * so innocent English ("clone the repo") is not mistaken for a repo reference.
 */
export function parseCodingRequest(task: string): ParsedCodingRequest {
  // Try each pattern in priority order. The first pattern whose capture
  // looks like a real repo reference wins. Patterns 2-5 require word
  // boundaries plus a repo-like token to avoid swallowing innocent
  // English like "clone the repo" → repo="the".
  const repoPatterns: RegExp[] = [
    // Strict explicit forms — accept anything as the value (legacy behaviour).
    /\brepo(?:url)?\s*[:=]\s*(\S+)/i,
    // Conversational forms — capture is validated below.
    /(?:^|[\s,.;])(?:the\s+)?repo\s+(?:is|=)\s+(\S+)/i,
    /(?:^|[\s,.;])(?:use|using|with)\s+repo\s+(\S+)/i,
    /(?:^|[\s,.;])clone\s+(?:from\s+)?(\S+)/i,
  ];
  let rawRepo: string | undefined;
  for (let i = 0; i < repoPatterns.length; i++) {
    const m = task.match(repoPatterns[i]);
    if (!m) continue;
    const candidate = m[1];
    // Pattern 0 (strict `repo:` / `repo=` / `repoUrl:`) trusts the user
    // verbatim — they explicitly tagged it. Patterns 1-3 are loose, so
    // the captured token MUST look repo-like or we discard the match.
    if (i === 0 || looksLikeRepoToken(candidate)) {
      rawRepo = candidate;
      break;
    }
  }

  // Branch hints: require an explicit delimiter (`branch:` / `branch=`)
  // OR the conversational "branch is <name>" form. Plain `branch <name>`
  // is rejected because natural sentences like "the default branch is
  // main" or "switch branch upstream" would otherwise capture filler
  // words ("the", "upstream") as branch names.
  const branchMatch =
    task.match(/\bbranch\s*[:=]\s*(\S+)/i) ??
    task.match(/(?:^|[\s,.;])branch\s+is\s+(\S+)/i);

  return {
    repoUrl: normalizeRepoHint(rawRepo),
    branch: branchMatch?.[1]?.replace(/[.,;:!?)\]]+$/, '') ?? 'main',
    taskDescription: task,
  };
}
