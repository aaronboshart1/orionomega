/**
 * @module agent/__tests__/spec-multiphase-fanout
 *
 * Task #174 regression: a synthetic 6-phase markdown spec — with two
 * phases marked dependent on earlier phases — flows through the
 * coding-mode planner + architect path and produces a preamble that:
 *
 *   1. Inlines the spec contents.
 *   2. Carries a "Multi-phase fan-out (CRITICAL)" instruction block.
 *   3. Lists six per-phase implementer chunks (one per `## Phase N`).
 *   4. Encodes the declared inter-phase dependencies as `Depends on`
 *      lines (so the planner emits explicit `dependsOn` edges).
 *   5. Mentions the `high`-complexity re-plan rule.
 *
 * The test also feeds the same spec through the standalone
 * {@link parseSpecPhases} parser to lock in the dependency-language
 * detection, and asserts that the feature-implementation architect
 * template prompt now mentions the multi-phase override + the new
 * optional `dependsOn` chunk field.
 */

import { describe, it, expect, vi } from 'vitest';
import { resolve as resolvePath } from 'node:path';
import {
  prepareCodingDispatch,
  buildCodingTaskPreamble,
} from '../coding-dispatch.js';
import {
  parseSpecPhases,
  loadSpecReferences,
  extractSpecReferences,
} from '../spec-loader.js';
import { buildFeatureImplementationTemplate } from '../../orchestration/coding/templates/feature-implementation.js';

const STUB_MODELS = {
  scanner: 'm', architect: 'm', implementer: 'm',
  stitcher: 'm', testWriter: 'm', reporter: 'm',
};
const STUB_NUMERIC = {
  scanner: 1, architect: 1, implementer: 1,
  stitcher: 1, testWriter: 1, reporter: 1,
};

const SIX_PHASE_SPEC = `# Synthetic Refactor Spec

## Phase 1: Bootstrap module layout
- Create the new package skeleton.
- Wire the build script.

## Phase 2: Extract pure utilities
- Move pure helpers out of the legacy module.
- Each helper independently mergeable.

## Phase 3: Refactor the executor core
- Replace the imperative loop with a state machine.

## Phase 4: Wire the new executor (depends on Phase 3)
- This phase depends on Phase 3 because it consumes the new state machine.
- Update all callers to the new entrypoint.

## Phase 5: Telemetry and observability
- Add structured logging to the new code paths.
- Independently mergeable.

## Phase 6: Documentation pass (after Phase 4)
- Update the architecture doc.
- Update the migration guide once the executor swap from Phase 4 is in.
`;

function fakeClone(_url: string, runDir: string): Promise<string> {
  return Promise.resolve(`${runDir}/repo`);
}

describe('Multi-phase spec fan-out (Task #174)', () => {
  describe('parseSpecPhases', () => {
    it('detects all six phases in the synthetic spec', () => {
      const phases = parseSpecPhases(SIX_PHASE_SPEC);
      expect(phases).toHaveLength(6);
      expect(phases.map((p) => p.id)).toEqual([
        'phase-1', 'phase-2', 'phase-3', 'phase-4', 'phase-5', 'phase-6',
      ]);
      expect(phases[0].title).toMatch(/Bootstrap module layout/);
      expect(phases[5].title).toMatch(/Documentation pass/);
    });

    it('encodes "depends on Phase N" → dependsOn=[phase-N]', () => {
      const phases = parseSpecPhases(SIX_PHASE_SPEC);
      const phase4 = phases.find((p) => p.id === 'phase-4')!;
      expect(phase4.dependsOn).toEqual(['phase-3']);
    });

    it('encodes "after Phase N" as a dependency too', () => {
      const phases = parseSpecPhases(SIX_PHASE_SPEC);
      const phase6 = phases.find((p) => p.id === 'phase-6')!;
      expect(phase6.dependsOn).toContain('phase-4');
    });

    it('leaves independent phases with no dependencies', () => {
      const phases = parseSpecPhases(SIX_PHASE_SPEC);
      for (const id of ['phase-1', 'phase-2', 'phase-3', 'phase-5']) {
        const p = phases.find((x) => x.id === id)!;
        expect(p.dependsOn).toEqual([]);
      }
    });

    it('returns an empty list when fewer than 3 phase markers are present', () => {
      expect(parseSpecPhases('## Phase 1\n## Phase 2\nbody')).toEqual([]);
    });

    it('falls back to H2 splitting on large specs without strict markers (May-2026 bug)', () => {
      // Build a ~32KB spec with ## Section headings — this is the
      // shape the Cannabis MSO Legal spec used, which previously
      // bypassed macro mode and blew the planner input window.
      const filler = 'lorem ipsum dolor sit amet '.repeat(160) + '\n';
      const big =
        '# Cannabis MSO Legal Operations Platform\n' +
        '## Authentication\n' + filler + filler +
        '## Case Management\n' + filler + filler +
        '## Billing\n' + filler + filler +
        '## Reporting\n' + filler + filler;
      expect(big.length).toBeGreaterThanOrEqual(30_000);
      const phases = parseSpecPhases(big);
      expect(phases.length).toBe(4);
      expect(phases.map((p) => p.title)).toEqual([
        'Authentication',
        'Case Management',
        'Billing',
        'Reporting',
      ]);
    });

    it('does NOT fall back to H2 splitting on small specs (avoids false positives)', () => {
      const small =
        '# Title\n## Intro\nshort\n## Setup\nshort\n## Conclusion\nshort\n';
      expect(parseSpecPhases(small)).toEqual([]);
    });
  });

  describe('extractSpecReferences', () => {
    it('finds .md / .txt / .spec references and skips URLs', () => {
      const refs = extractSpecReferences(
        'Implement fixes for SKILLS-SDK-REFACTOR-SPEC.md per docs/plan.txt and https://x/y.md',
      );
      expect(refs).toContain('SKILLS-SDK-REFACTOR-SPEC.md');
      expect(refs).toContain('docs/plan.txt');
      expect(refs.some((r) => r.startsWith('https'))).toBe(false);
    });
  });

  describe('loadSpecReferences (sandbox + parsing)', () => {
    it('resolves a referenced file under the checkout root and parses phases', () => {
      const readFile = vi.fn((p: string) => {
        if (p.endsWith('SPEC.md')) return SIX_PHASE_SPEC;
        throw new Error('ENOENT');
      });
      const out = loadSpecReferences({
        task: 'implement fixes for SPEC.md',
        roots: ['/tmp/ws/output/run-A/repo', '/tmp/ws'],
        readFile,
      });
      expect(out).toHaveLength(1);
      expect(out[0].phases).toHaveLength(6);
      expect(out[0].resolvedPath).toBe(resolvePath('/tmp/ws/output/run-A/repo', 'SPEC.md'));
    });

    it('refuses path-traversal escapes', () => {
      const readFile = vi.fn(() => 'whatever');
      const out = loadSpecReferences({
        task: 'see ../../etc/passwd.md',
        roots: ['/tmp/ws/repo'],
        readFile,
      });
      expect(out).toEqual([]);
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  describe('buildCodingTaskPreamble (multi-phase block)', () => {
    const base = {
      userTask: 'implement fixes for SPEC.md',
      remoteUrl: 'https://github.com/foo/bar.git',
      branch: 'main',
      checkoutPath: '/tmp/ws/output/run-A/repo',
      headCommit: 'deadbeef',
    };

    it('appends a Multi-phase fan-out CRITICAL block when ≥3 phases are detected', () => {
      const specs = [
        {
          reference: 'SPEC.md',
          resolvedPath: '/tmp/ws/output/run-A/repo/SPEC.md',
          contents: SIX_PHASE_SPEC,
          truncated: false,
          phases: parseSpecPhases(SIX_PHASE_SPEC),
        },
      ];
      const text = buildCodingTaskPreamble({ ...base, specs });

      // 1. Section header is present.
      expect(text).toMatch(/Multi-phase fan-out \(CRITICAL\)/);

      // 2. One implementer per phase rule.
      expect(text).toMatch(/one CODING_AGENT implementer node per phase/);

      // 3. Lists six per-phase entries.
      for (let i = 1; i <= 6; i++) {
        expect(text).toMatch(new RegExp(`\\*\\*phase-${i}\\*\\*`));
      }

      // 4. Dependent phases carry "Depends on" lines.
      expect(text).toMatch(/phase-4.*Depends on:.*phase-3/);
      expect(text).toMatch(/phase-6.*Depends on:.*phase-4/);

      // 5. Independent phases are explicitly marked parallelisable.
      expect(text).toMatch(/phase-1.*independent \(parallelisable\)/);
      expect(text).toMatch(/phase-5.*independent \(parallelisable\)/);

      // 6. Complexity safety-net wording surfaces the re-plan rule.
      expect(text).toMatch(/Complexity safety net/);
      expect(text).toMatch(/Subdivide it into 2–4 sub-chunks/);

      // 7. Spec contents are inlined verbatim so the planner can read them.
      expect(text).toContain('Phase 4: Wire the new executor (depends on Phase 3)');
    });

    it('omits the multi-phase block when no specs were resolved', () => {
      const text = buildCodingTaskPreamble({ ...base, specs: [] });
      expect(text).not.toMatch(/Multi-phase fan-out/);
    });
  });

  describe('prepareCodingDispatch (end-to-end through the planner preamble)', () => {
    it('threads a 6-phase spec through to the preamble with all dependencies encoded', async () => {
      const out = await prepareCodingDispatch({
        userTask: 'implement fixes for SPEC.md and ship it',
        workspaceDir: '/tmp/ws',
        runId: 'run-MP1',
        remote: { repoHint: 'https://github.com/foo/bar.git' },
        cloneRepo: vi.fn(fakeClone),
        getHeadCommit: async () => 'a'.repeat(40),
        resolveRemote: async () => 'https://github.com/foo/bar.git',
        mkdir: () => {},
        loadSpecReferences: () => [
          {
            reference: 'SPEC.md',
            resolvedPath: '/tmp/ws/output/run-MP1/repo/SPEC.md',
            contents: SIX_PHASE_SPEC,
            truncated: false,
            phases: parseSpecPhases(SIX_PHASE_SPEC),
          },
        ],
      });

      // Spec metadata is exposed on the dispatch result for the bridge to log.
      expect(out.specs).toHaveLength(1);
      expect(out.specs[0].phases).toHaveLength(6);

      // The planner preamble carries the full multi-phase contract.
      const text = out.codingTaskPreamble;
      expect(text).toMatch(/Multi-phase fan-out \(CRITICAL\)/);
      expect(text).toMatch(/one CODING_AGENT implementer node per phase/);

      // ≥6 phase entries (acceptance criterion: at least 6 implementer chunks).
      const phaseLineMatches = text.match(/\*\*phase-\d+\*\*/g) ?? [];
      expect(phaseLineMatches.length).toBeGreaterThanOrEqual(6);

      // Dependent-phase ordering is preserved.
      expect(text).toMatch(/phase-4.*Depends on:.*phase-3/);
      expect(text).toMatch(/phase-6.*Depends on:.*phase-4/);

      // Independent phases stay parallelisable siblings.
      const independent = ['phase-1', 'phase-2', 'phase-3', 'phase-5'];
      for (const id of independent) {
        const re = new RegExp(`\\*\\*${id}\\*\\*[^\\n]*independent \\(parallelisable\\)`);
        expect(text).toMatch(re);
      }
    });
  });

  describe('feature-implementation architect template (prompt contract)', () => {
    it('documents the multi-phase override + dependsOn chunk field', () => {
      const dag = buildFeatureImplementationTemplate({
        task: 'implement fixes for SPEC.md',
        cwd: '/tmp/ws/output/run-T/repo',
        models: STUB_MODELS,
        budgets: STUB_NUMERIC,
      });
      const architect = dag.find((n) => n.id === 'architecture-design');
      expect(architect).toBeDefined();
      const prompt = architect!.agent!.task;

      // Multi-phase rule is now part of the architect contract.
      expect(prompt).toMatch(/Multi-phase spec override/);
      expect(prompt).toMatch(/one chunk per phase/);
      expect(prompt).toMatch(/3 or more|3 or\s*\n*\s*more/);

      // The chunk JSON schema example exposes the new optional field.
      expect(prompt).toMatch(/"dependsOn"\s*:\s*\[\]/);

      // Complexity safety-net guidance survived the rewrite.
      expect(prompt).toMatch(/Complexity safety net/);
      expect(prompt).toMatch(/subdivide it into 2–4 sibling chunks/);
    });
  });
});
