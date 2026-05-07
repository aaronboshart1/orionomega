/**
 * @module agent/spec-loader
 *
 * Task #174: Pre-load multi-phase specification files referenced by a
 * coding-mode user task so the planner / architect can fan out one
 * implementer chunk per spec phase instead of collapsing the whole spec
 * into a single monolithic implement node.
 *
 * The loader is intentionally permissive about *what* it considers a
 * "spec": any token in the user task ending in `.md`, `.txt` or `.spec`
 * is treated as a candidate path. Each candidate is resolved under the
 * checkout / workspace root with a path-traversal guard, read with the
 * same 5 MB cap the gateway file-read endpoint uses, and parsed for
 * phase-style structural markers. References that cannot be resolved
 * are silently skipped — the worst case is the historical behaviour
 * (no spec contents in the preamble).
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';

/** 5 MB — mirrors the gateway file-read endpoint cap (see replit.md Gotchas). */
export const SPEC_FILE_CAP_BYTES = 5 * 1024 * 1024;

/** A single phase parsed out of a referenced spec. */
export interface SpecPhase {
  /** 1-indexed ordinal as the phase appears in the document. */
  index: number;
  /** Stable chunk id derived from the index, e.g. `phase-1`. */
  id: string;
  /** Phase title (heading text minus the marker). */
  title: string;
  /** Raw heading-level number found in the source (e.g. the `1` in `## Phase 1`). */
  declaredNumber: number;
  /** Body content from this heading up to (but not including) the next phase heading. */
  body: string;
  /**
   * Heuristic complexity tier based on body size. `high` triggers a
   * one-shot re-plan request in the architect prompt.
   */
  estimatedComplexity: 'low' | 'medium' | 'high';
  /**
   * Other phase ids this phase depends on. Populated from explicit
   * dependency language in the body — `depends on Phase N`,
   * `after Phase N`, `requires Phase N`. Empty when independent.
   */
  dependsOn: string[];
}

/** A successfully-loaded spec reference. */
export interface SpecReference {
  /** The reference token as it appeared in the user task. */
  reference: string;
  /** Absolute path the reference resolved to (under a sandbox root). */
  resolvedPath: string;
  /** File contents (capped at {@link SPEC_FILE_CAP_BYTES}). */
  contents: string;
  /** True when the file exceeded the cap and was truncated. */
  truncated: boolean;
  /** Detected phases (empty when fewer than 3 phase markers were found). */
  phases: SpecPhase[];
}

/**
 * Extract candidate spec-file references from a user task.
 *
 * Matches paths / filenames ending in `.md`, `.txt`, or `.spec`. The
 * pattern deliberately allows backticks, slashes and dots so both bare
 * filenames (`SPEC.md`) and relative paths (`docs/foo.spec`) are picked
 * up. URLs (`https://...`) are filtered out — they aren't local files.
 */
export function extractSpecReferences(task: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // (?<![\w/]) avoids matching inside an unrelated longer token; the
  // tail (?![\w]) keeps us from grabbing a longer extension.
  const pat = /(?<![\w])([\w./-]+\.(?:md|txt|spec))(?![\w])/gi;
  for (const m of task.matchAll(pat)) {
    const ref = m[1];
    if (/^https?:/i.test(ref)) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * Extract bare-filename candidates from a user task — tokens that
 * *look* like spec filenames but lack a recognised extension. Only
 * tokens that appear inside backticks, single quotes, or double quotes
 * are considered, plus all-caps shouty references like `SPEC` or
 * `DESIGN`. The actual existence-check happens in {@link loadSpecReferences}
 * by probing each candidate under the sandbox roots with `.md`,
 * `.txt`, and `.spec` appended; non-existent candidates are dropped.
 *
 * This is the bare-filename branch the task acceptance criteria
 * explicitly call out (`SPEC` → resolves to `SPEC.md` under cwd).
 */
export function extractBareFilenameReferences(task: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Backtick / quoted tokens (no extension dot). e.g. `SPEC`, "DESIGN", 'plan'.
  const quoted = /[`'"]([A-Za-z][\w./-]{0,80})[`'"]/g;
  for (const m of task.matchAll(quoted)) {
    const t = m[1];
    if (/\.(md|txt|spec)$/i.test(t)) continue; // already handled by extractSpecReferences
    if (/^https?:/i.test(t)) continue;
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  // ALLCAPS shouty references (SPEC, README, DESIGN, ROADMAP, ...).
  // Reject when followed by another word char, slash or hyphen (still
  // part of a longer token), but allow trailing `.` so sentence-ending
  // references like `... in SPEC.` still match.
  const shouty = /(?<![\w/])([A-Z][A-Z0-9_]{2,30})(?![\w/-])/g;
  for (const m of task.matchAll(shouty)) {
    const t = m[1];
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/**
 * Parse phase-style structural markers out of a markdown / plain-text
 * document. Returns an empty list when fewer than 3 markers are found
 * (the fan-out trigger from the bug report's acceptance criteria).
 *
 * Supported patterns:
 *   - `## Phase N`, `### Phase N`, `## Stage N`, `## Step N`
 *   - `## N. Title` / `# N. Title` (numbered heading)
 *
 * "Phase N:" / "Stage N -" suffixes are tolerated.
 */
export function parseSpecPhases(content: string): SpecPhase[] {
  const lines = content.split(/\r?\n/);
  const phaseRe = /^#{1,6}\s+(?:Phase|Stage|Step)\s+(\d+)(?:\s*[:\-.]\s*(.*))?\s*$/i;
  const numberedRe = /^#{1,6}\s+(\d+)\.\s+(.+?)\s*$/;
  const hits: Array<{ lineNo: number; declaredNumber: number; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    let m = lines[i].match(phaseRe);
    if (m) {
      const decl = parseInt(m[1], 10);
      hits.push({ lineNo: i, declaredNumber: decl, title: (m[2] ?? '').trim() || `Phase ${decl}` });
      continue;
    }
    m = lines[i].match(numberedRe);
    if (m) {
      hits.push({ lineNo: i, declaredNumber: parseInt(m[1], 10), title: m[2].trim() });
    }
  }
  if (hits.length < 3) return [];

  const phases: SpecPhase[] = hits.map((h, i) => {
    const start = h.lineNo;
    const end = i + 1 < hits.length ? hits[i + 1].lineNo : lines.length;
    const body = lines.slice(start, end).join('\n');
    return {
      index: i + 1,
      id: `phase-${i + 1}`,
      title: h.title,
      declaredNumber: h.declaredNumber,
      body,
      estimatedComplexity: estimateComplexity(body),
      dependsOn: [],
    };
  });

  // Map the declared phase number → ordinal id so dependency language
  // that references e.g. "Phase 3" resolves correctly even when the
  // numbering in the source skips or restarts.
  const byDeclared = new Map<number, string>();
  for (const p of phases) byDeclared.set(p.declaredNumber, p.id);

  const depRe = /\b(?:depends on|after|requires)\s+Phase\s+(\d+)\b/gi;
  for (const p of phases) {
    for (const m of p.body.matchAll(depRe)) {
      const n = parseInt(m[1], 10);
      const dep = byDeclared.get(n);
      if (dep && dep !== p.id && !p.dependsOn.includes(dep)) {
        p.dependsOn.push(dep);
      }
    }
  }
  return phases;
}

function estimateComplexity(body: string): 'low' | 'medium' | 'high' {
  const lineCount = body.split(/\r?\n/).length;
  if (lineCount > 60) return 'high';
  if (lineCount > 25) return 'medium';
  return 'low';
}

/** Inputs to {@link loadSpecReferences}. */
export interface LoadSpecReferencesInput {
  /** The raw user task. References are extracted from here. */
  task: string;
  /**
   * Sandbox roots, in priority order. The loader tries each in turn and
   * uses the first one where the reference resolves to an existing file
   * **without escaping the root** (defends against `../../etc/passwd`).
   * Typically `[checkoutPath, workspaceDir]`.
   */
  roots: string[];
  /** Injected for unit tests; defaults to `readFileSync`. */
  readFile?: (absPath: string) => string;
}

/**
 * Resolve every candidate reference in `input.task` to a {@link SpecReference}.
 * References that cannot be resolved under any sandbox root are silently
 * dropped — this is best-effort context loading, not a hard error.
 */
export function loadSpecReferences(input: LoadSpecReferencesInput): SpecReference[] {
  const extRefs = extractSpecReferences(input.task);
  const bareRefs = extractBareFilenameReferences(input.task);
  // Each candidate is a list of relative paths to probe under each root.
  // Extension-bearing refs probe a single path; bare refs probe with
  // `.md`, `.txt`, `.spec` appended in priority order.
  const candidates: Array<{ display: string; probes: string[] }> = [];
  for (const r of extRefs) candidates.push({ display: r, probes: [r] });
  for (const r of bareRefs) {
    candidates.push({ display: r, probes: [`${r}.md`, `${r}.txt`, `${r}.spec`] });
  }
  if (candidates.length === 0) return [];
  const read = input.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const roots = input.roots
    .filter((r): r is string => typeof r === 'string' && r.length > 0)
    .map((r) => resolvePath(r));
  const out: SpecReference[] = [];
  const seenResolved = new Set<string>();
  for (const cand of candidates) {
    let contents: string | null = null;
    let resolved = '';
    outer: for (const root of roots) {
      for (const probe of cand.probes) {
        const candidate = resolvePath(root, probe);
        // Sandbox guard: candidate must live under root (mirrors the
        // gateway file-read workspace-root restriction).
        if (candidate !== root && !candidate.startsWith(root + sep)) continue;
        try {
          contents = read(candidate);
          resolved = candidate;
          break outer;
        } catch {
          // Try next probe / root.
        }
      }
    }
    if (contents == null) continue;
    if (seenResolved.has(resolved)) continue; // dedupe across bare/ext aliases
    seenResolved.add(resolved);
    const truncated = contents.length > SPEC_FILE_CAP_BYTES;
    if (truncated) contents = contents.slice(0, SPEC_FILE_CAP_BYTES);
    out.push({
      reference: cand.display,
      resolvedPath: resolved,
      contents,
      truncated,
      phases: parseSpecPhases(contents),
    });
  }
  return out;
}

/**
 * Render the loaded spec references into a Markdown block for inclusion
 * in the planner preamble. When at least one reference contains ≥3
 * phase markers, the block opens with a strongly-worded "Multi-phase
 * fan-out (CRITICAL)" instruction that mandates one CODING_AGENT node
 * per phase, honours `dependsOn`, parallelises independent phases, and
 * asks the planner to subdivide any `high`-complexity phase before
 * dispatching it.
 *
 * Returns an empty string when there are no resolvable references.
 */
export function renderSpecPreambleBlock(specs: SpecReference[]): string {
  if (specs.length === 0) return '';
  const multiPhase = specs.filter((s) => s.phases.length >= 3);
  const out: string[] = [];

  if (multiPhase.length > 0) {
    out.push('### Multi-phase fan-out (CRITICAL)');
    out.push(
      'The user referenced one or more multi-phase specifications (≥3 `## Phase N` / `## Step N` ' +
      'markers). You MUST emit **one CODING_AGENT implementer node per phase** — do NOT collapse the ' +
      'whole spec into a single monolithic `implement` node. Parallelise independent phases in the ' +
      'same DAG layer. Phases listed under a phase\'s `Depends on` line below MUST become explicit ' +
      '`dependsOn` edges between the corresponding implementer nodes. Use stable per-phase node ids ' +
      'such as `implement-phase-1`, `implement-phase-2`, … so the dependency edges are obvious.',
    );
    out.push(
      '**Complexity safety net:** any phase tagged `estimatedComplexity: high` below is too large for ' +
      'one implementer in one shot. Subdivide it into 2–4 sub-chunks (still depending on the same ' +
      'predecessor, still feeding the same successor) BEFORE emitting the DAG. Cap subdivision at one ' +
      'pass — do not recurse.',
    );
  }

  for (const spec of specs) {
    out.push('');
    out.push(`### Referenced spec: \`${spec.reference}\``);
    out.push(`Resolved path: \`${spec.resolvedPath}\``);
    if (spec.phases.length >= 3) {
      out.push(`Detected ${spec.phases.length} phases:`);
      for (const p of spec.phases) {
        const dep = p.dependsOn.length > 0 ? ` — Depends on: ${p.dependsOn.join(', ')}` : ' — independent (parallelisable)';
        out.push(`  - **${p.id}** "${p.title}" (complexity: ${p.estimatedComplexity})${dep}`);
      }
    } else {
      out.push('(No multi-phase markers detected — included as plain context.)');
    }
    out.push('');
    out.push('Spec contents:');
    out.push('```markdown');
    out.push(spec.contents.length > 60_000 ? spec.contents.slice(0, 60_000) + '\n…[truncated for preamble]' : spec.contents);
    out.push('```');
    if (spec.truncated) {
      out.push(`(File was truncated at ${SPEC_FILE_CAP_BYTES} bytes during read.)`);
    }
  }

  return out.join('\n');
}
