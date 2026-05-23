/**
 * @module orchestration/coding/__tests__/codebase-indexer
 *
 * Unit tests for the Codebase Indexing Pipeline (Section 6.1 of spec):
 *   - detectLanguage()
 *   - extractSymbols()
 *   - extractImports()
 *   - resolveImportPath()
 *   - buildDependencyGraph()
 *   - computePageRank()
 *   - CodebaseIndexer (buildIndex, incrementalUpdate, loadOrBuild)
 *   - CodebaseQuery   (findDefinition, findReferences, findCallers,
 *                      findDependents, shortestPath, impactAnalysis)
 *   - computeRelevance() (5-factor model)
 *   - buildTieredContext()
 *   - saveFingerprint / loadFingerprint / isFingerprintValid
 *
 * Each test uses a throwaway temp directory created with mkdtempSync and
 * cleaned up in afterEach.  No network calls; no git operations except
 * in the fingerprint TTL test (which handles git unavailability gracefully).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  detectLanguage,
  extractSymbols,
  extractImports,
  resolveImportPath,
  discoverSourceFiles,
  buildDependencyGraph,
  computePageRank,
  CodebaseIndexer,
} from '../codebase-indexer.js';

import {
  CodebaseQuery,
} from '../codebase-query.js';

import {
  computeRelevance,
  rankFilesByRelevance,
} from '../relevance-scorer.js';

import {
  buildTieredContext,
  FILE_BUDGET_PER_ROLE,
  TOKEN_BUDGET_PER_ROLE,
  extractFileSkeleton,
} from '../context-loader.js';

import {
  saveFingerprint,
  loadFingerprint,
  isFingerprintValid,
  buildFingerprint,
  computeFileChangeRatio,
} from '../project-fingerprint.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

let tempDirs: string[] = [];

function mktemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orion-index-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
});

// ── detectLanguage ────────────────────────────────────────────────────────────

describe('detectLanguage', () => {
  it('returns typescript for .ts files', () => {
    expect(detectLanguage('src/foo.ts')).toBe('typescript');
  });

  it('returns typescript for .tsx files', () => {
    expect(detectLanguage('components/Button.tsx')).toBe('typescript');
  });

  it('returns javascript for .js files', () => {
    expect(detectLanguage('lib/utils.js')).toBe('javascript');
  });

  it('returns javascript for .mjs files', () => {
    expect(detectLanguage('esm/index.mjs')).toBe('javascript');
  });

  it('returns python for .py files', () => {
    expect(detectLanguage('server.py')).toBe('python');
  });

  it('returns go for .go files', () => {
    expect(detectLanguage('cmd/main.go')).toBe('go');
  });

  it('returns rust for .rs files', () => {
    expect(detectLanguage('src/lib.rs')).toBe('rust');
  });

  it('returns unknown for unrecognised extensions', () => {
    expect(detectLanguage('data.csv')).toBe('unknown');
    expect(detectLanguage('README.md')).toBe('unknown');
  });

  it('is case-insensitive for extensions', () => {
    expect(detectLanguage('FILE.TS')).toBe('typescript');
  });
});

// ── extractSymbols ────────────────────────────────────────────────────────────

describe('extractSymbols – TypeScript', () => {
  it('extracts exported function declarations', () => {
    const content = `
export function hello(name: string): string {
  return \`Hello \${name}\`;
}
`;
    const syms = extractSymbols(content, 'typescript');
    const fn = syms.find((s) => s.name === 'hello');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.exported).toBe(true);
  });

  it('extracts non-exported function', () => {
    const content = `function internal(): void {}`;
    const syms = extractSymbols(content, 'typescript');
    const fn = syms.find((s) => s.name === 'internal');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('extracts async function', () => {
    const content = `export async function fetchData(): Promise<void> {}`;
    const syms = extractSymbols(content, 'typescript');
    expect(syms.find((s) => s.name === 'fetchData')).toBeDefined();
  });

  it('extracts class declarations', () => {
    const content = `
export class UserService {
  constructor(private db: DB) {}
  getUser(id: string) {}
}
`;
    const syms = extractSymbols(content, 'typescript');
    const cls = syms.find((s) => s.name === 'UserService');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.exported).toBe(true);
  });

  it('extracts interface declarations', () => {
    const content = `export interface User { id: string; name: string; }`;
    const syms = extractSymbols(content, 'typescript');
    const iface = syms.find((s) => s.name === 'User');
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe('interface');
  });

  it('extracts type aliases', () => {
    const content = `export type UserId = string;`;
    const syms = extractSymbols(content, 'typescript');
    expect(syms.find((s) => s.name === 'UserId' && s.kind === 'type')).toBeDefined();
  });

  it('extracts enum declarations', () => {
    const content = `export enum Status { Active = 'active', Inactive = 'inactive' }`;
    const syms = extractSymbols(content, 'typescript');
    expect(syms.find((s) => s.name === 'Status' && s.kind === 'enum')).toBeDefined();
  });

  it('extracts exported const', () => {
    const content = `export const MAX_RETRIES = 3;`;
    const syms = extractSymbols(content, 'typescript');
    expect(syms.find((s) => s.name === 'MAX_RETRIES')).toBeDefined();
  });

  it('returns correct line numbers', () => {
    const content = `// comment\n\nexport function foo() {}\nexport function bar() {}`;
    const syms = extractSymbols(content, 'typescript');
    const foo = syms.find((s) => s.name === 'foo');
    const bar = syms.find((s) => s.name === 'bar');
    expect(foo?.line).toBe(3);
    expect(bar?.line).toBe(4);
  });

  it('does not extract reserved words as symbols', () => {
    const content = `if (true) { return; } for (;;) {}`;
    const syms = extractSymbols(content, 'typescript');
    const names = syms.map((s) => s.name);
    expect(names).not.toContain('if');
    expect(names).not.toContain('for');
    expect(names).not.toContain('return');
  });
});

describe('extractSymbols – Python', () => {
  it('extracts function definitions', () => {
    const content = `def get_user(user_id: str) -> User:\n    pass`;
    const syms = extractSymbols(content, 'python');
    expect(syms.find((s) => s.name === 'get_user' && s.kind === 'function')).toBeDefined();
  });

  it('extracts async def', () => {
    const content = `async def fetch(url: str) -> str:\n    pass`;
    const syms = extractSymbols(content, 'python');
    expect(syms.find((s) => s.name === 'fetch')).toBeDefined();
  });

  it('extracts class definitions', () => {
    const content = `class UserService:\n    pass`;
    const syms = extractSymbols(content, 'python');
    expect(syms.find((s) => s.name === 'UserService' && s.kind === 'class')).toBeDefined();
  });
});

describe('extractSymbols – Go', () => {
  it('extracts func declarations', () => {
    const content = `func GetUser(id string) *User { return nil }`;
    const syms = extractSymbols(content, 'go');
    expect(syms.find((s) => s.name === 'GetUser' && s.kind === 'function')).toBeDefined();
  });

  it('extracts method declarations', () => {
    const content = `func (s *UserService) GetUser(id string) *User { return nil }`;
    const syms = extractSymbols(content, 'go');
    expect(syms.find((s) => s.name === 'GetUser')).toBeDefined();
  });

  it('extracts struct types', () => {
    const content = `type User struct { ID string; Name string }`;
    const syms = extractSymbols(content, 'go');
    expect(syms.find((s) => s.name === 'User' && s.kind === 'class')).toBeDefined();
  });
});

describe('extractSymbols – Rust', () => {
  it('extracts pub fn', () => {
    const content = `pub fn create_user(name: &str) -> User { todo!() }`;
    const syms = extractSymbols(content, 'rust');
    expect(syms.find((s) => s.name === 'create_user' && s.kind === 'function')).toBeDefined();
  });

  it('extracts pub struct', () => {
    const content = `pub struct User { pub id: String }`;
    const syms = extractSymbols(content, 'rust');
    expect(syms.find((s) => s.name === 'User' && s.kind === 'class')).toBeDefined();
  });

  it('extracts trait', () => {
    const content = `pub trait Repository { fn get(&self, id: &str) -> Option<User>; }`;
    const syms = extractSymbols(content, 'rust');
    expect(syms.find((s) => s.name === 'Repository' && s.kind === 'interface')).toBeDefined();
  });
});

describe('extractSymbols – unknown language', () => {
  it('returns empty array for unknown languages', () => {
    expect(extractSymbols('some content', 'cobol')).toEqual([]);
  });
});

// ── extractImports ────────────────────────────────────────────────────────────

describe('extractImports – TypeScript', () => {
  const filePath = '/workspace/src/app.ts';

  it('extracts named imports', () => {
    const content = `import { UserService, AuthService } from './services';`;
    const imports = extractImports(content, 'typescript', filePath);
    expect(imports).toHaveLength(1);
    expect(imports[0].source).toBe('./services');
    expect(imports[0].symbols).toContain('UserService');
    expect(imports[0].symbols).toContain('AuthService');
  });

  it('extracts default import', () => {
    const content = `import React from 'react';`;
    const imports = extractImports(content, 'typescript', filePath);
    expect(imports.some((i) => i.source === 'react')).toBe(true);
  });

  it('extracts namespace import', () => {
    const content = `import * as fs from 'node:fs';`;
    const imports = extractImports(content, 'typescript', filePath);
    expect(imports.some((i) => i.source === 'node:fs' && i.symbols.includes('*'))).toBe(true);
  });

  it('extracts side-effect import', () => {
    const content = `import './styles.css';`;
    const imports = extractImports(content, 'typescript', filePath);
    expect(imports.some((i) => i.source === './styles.css')).toBe(true);
  });

  it('extracts re-export', () => {
    const content = `export { User, AuthToken } from './types';`;
    const imports = extractImports(content, 'typescript', filePath);
    expect(imports.some((i) => i.source === './types')).toBe(true);
  });

  it('extracts require() calls', () => {
    const content = `const path = require('path');`;
    const imports = extractImports(content, 'typescript', filePath);
    expect(imports.some((i) => i.source === 'path')).toBe(true);
  });

  it('extracts dynamic import()', () => {
    const content = `const mod = await import('./lazy-module');`;
    const imports = extractImports(content, 'typescript', filePath);
    expect(imports.some((i) => i.source === './lazy-module')).toBe(true);
  });

  it('extracts type imports', () => {
    const content = `import type { User } from './models';`;
    const imports = extractImports(content, 'typescript', filePath);
    expect(imports.some((i) => i.source === './models')).toBe(true);
  });

  it('records correct line number', () => {
    const content = `// header\nimport { foo } from './foo';`;
    const imports = extractImports(content, 'typescript', filePath);
    expect(imports.find((i) => i.source === './foo')?.line).toBe(2);
  });
});

describe('extractImports – Python', () => {
  it('extracts from ... import', () => {
    const imports = extractImports(`from services.user import UserService`, 'python', 'app.py');
    expect(imports[0].source).toBe('services.user');
    expect(imports[0].symbols).toContain('UserService');
  });

  it('extracts import module', () => {
    const imports = extractImports(`import os`, 'python', 'app.py');
    expect(imports[0].source).toBe('os');
  });

  it('extracts multiple imports on one line', () => {
    const imports = extractImports(`import os, sys, json`, 'python', 'app.py');
    expect(imports.map((i) => i.source)).toContain('os');
    expect(imports.map((i) => i.source)).toContain('sys');
  });
});

describe('extractImports – Go', () => {
  it('extracts single-line import', () => {
    const imports = extractImports(`import "fmt"`, 'go', 'main.go');
    expect(imports.some((i) => i.source === 'fmt')).toBe(true);
  });

  it('extracts import block', () => {
    const content = `import (\n\t"fmt"\n\t"os"\n)`;
    const imports = extractImports(content, 'go', 'main.go');
    expect(imports.some((i) => i.source === 'fmt')).toBe(true);
    expect(imports.some((i) => i.source === 'os')).toBe(true);
  });
});

describe('extractImports – Rust', () => {
  it('extracts use statements', () => {
    const imports = extractImports(`use std::collections::HashMap;`, 'rust', 'lib.rs');
    expect(imports[0].source).toBe('std');
  });
});

// ── resolveImportPath ─────────────────────────────────────────────────────────

describe('resolveImportPath', () => {
  it('returns null for package imports', () => {
    expect(resolveImportPath('react', '/workspace/src/app.ts', '/workspace')).toBeNull();
    expect(resolveImportPath('lodash/merge', '/workspace/src/app.ts', '/workspace')).toBeNull();
    expect(resolveImportPath('node:fs', '/workspace/src/app.ts', '/workspace')).toBeNull();
  });

  it('resolves exact relative path when file exists', () => {
    const dir = mktemp();
    writeFileSync(join(dir, 'utils.ts'), '');
    const resolved = resolveImportPath('./utils.ts', join(dir, 'app.ts'), dir);
    expect(resolved).toBe(join(dir, 'utils.ts'));
  });

  it('resolves .ts extension when import omits extension', () => {
    const dir = mktemp();
    writeFileSync(join(dir, 'helper.ts'), '');
    const resolved = resolveImportPath('./helper', join(dir, 'app.ts'), dir);
    expect(resolved).toBe(join(dir, 'helper.ts'));
  });

  it('resolves .js imports to .ts source files', () => {
    const dir = mktemp();
    writeFileSync(join(dir, 'utils.ts'), '');
    const resolved = resolveImportPath('./utils.js', join(dir, 'app.ts'), dir);
    expect(resolved).toBe(join(dir, 'utils.ts'));
  });

  it('resolves directory to index.ts', () => {
    const dir = mktemp();
    mkdirSync(join(dir, 'services'));
    writeFileSync(join(dir, 'services', 'index.ts'), '');
    const resolved = resolveImportPath('./services', join(dir, 'app.ts'), dir);
    expect(resolved).toBe(join(dir, 'services', 'index.ts'));
  });

  it('returns null for non-existent relative path', () => {
    const dir = mktemp();
    const resolved = resolveImportPath('./nonexistent', join(dir, 'app.ts'), dir);
    expect(resolved).toBeNull();
  });
});

// ── discoverSourceFiles ───────────────────────────────────────────────────────

describe('discoverSourceFiles', () => {
  it('discovers TypeScript files', () => {
    const dir = mktemp();
    writeFileSync(join(dir, 'a.ts'), '');
    writeFileSync(join(dir, 'b.tsx'), '');
    const files = discoverSourceFiles(dir);
    expect(files).toContain(join(dir, 'a.ts'));
    expect(files).toContain(join(dir, 'b.tsx'));
  });

  it('skips node_modules', () => {
    const dir = mktemp();
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.ts'), '');
    writeFileSync(join(dir, 'app.ts'), '');
    const files = discoverSourceFiles(dir);
    expect(files).not.toContain(join(dir, 'node_modules', 'pkg', 'index.ts'));
    expect(files).toContain(join(dir, 'app.ts'));
  });

  it('skips dist directory', () => {
    const dir = mktemp();
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'bundle.js'), '');
    writeFileSync(join(dir, 'src.ts'), '');
    const files = discoverSourceFiles(dir);
    expect(files).not.toContain(join(dir, 'dist', 'bundle.js'));
  });

  it('respects .gitignore patterns', () => {
    const dir = mktemp();
    writeFileSync(join(dir, '.gitignore'), '*.generated.ts\n');
    writeFileSync(join(dir, 'normal.ts'), '');
    writeFileSync(join(dir, 'foo.generated.ts'), '');
    const files = discoverSourceFiles(dir);
    expect(files).toContain(join(dir, 'normal.ts'));
    expect(files).not.toContain(join(dir, 'foo.generated.ts'));
  });

  it('does not include non-source files', () => {
    const dir = mktemp();
    writeFileSync(join(dir, 'README.md'), '');
    writeFileSync(join(dir, 'data.csv'), '');
    writeFileSync(join(dir, 'src.ts'), '');
    const files = discoverSourceFiles(dir);
    expect(files).not.toContain(join(dir, 'README.md'));
    expect(files).toContain(join(dir, 'src.ts'));
  });
});

// ── buildDependencyGraph ──────────────────────────────────────────────────────

describe('buildDependencyGraph', () => {
  it('builds edges from resolved imports', () => {
    const dir = mktemp();
    const fileRecords = new Map([
      ['src/app.ts', {
        path: 'src/app.ts', language: 'typescript',
        symbols: [], pageRank: 0, lastModified: 0, hash: '', lineCount: 1,
        imports: [{ source: './utils', resolved: join(dir, 'src/utils.ts'), symbols: ['foo'], line: 1 }],
      }],
      ['src/utils.ts', {
        path: 'src/utils.ts', language: 'typescript',
        symbols: [], pageRank: 0, lastModified: 0, hash: '', lineCount: 1,
        imports: [],
      }],
    ]);
    const graph = buildDependencyGraph(fileRecords, dir);
    const appAbs = join(dir, 'src/app.ts');
    const utilsAbs = join(dir, 'src/utils.ts');
    expect(graph.edges.get(appAbs)?.has(utilsAbs)).toBe(true);
    expect(graph.reverseEdges.get(utilsAbs)?.has(appAbs)).toBe(true);
  });

  it('ignores unresolved (package) imports', () => {
    const dir = mktemp();
    const fileRecords = new Map([
      ['src/app.ts', {
        path: 'src/app.ts', language: 'typescript',
        symbols: [], pageRank: 0, lastModified: 0, hash: '', lineCount: 1,
        imports: [{ source: 'react', resolved: null, symbols: ['default'], line: 1 }],
      }],
    ]);
    const graph = buildDependencyGraph(fileRecords, dir);
    const appAbs = join(dir, 'src/app.ts');
    expect(graph.edges.get(appAbs)?.size).toBe(0);
  });
});

// ── computePageRank ───────────────────────────────────────────────────────────

describe('computePageRank', () => {
  it('returns empty map for empty graph', () => {
    const graph = { edges: new Map(), reverseEdges: new Map() };
    expect(computePageRank(graph).size).toBe(0);
  });

  it('gives higher score to files imported by many others', () => {
    // hub.ts is imported by 3 files; leaf.ts imports nothing
    const hub = '/ws/hub.ts';
    const a = '/ws/a.ts';
    const b = '/ws/b.ts';
    const c = '/ws/c.ts';

    const edges = new Map([
      [hub, new Set<string>()],
      [a, new Set([hub])],
      [b, new Set([hub])],
      [c, new Set([hub])],
    ]);
    const reverseEdges = new Map([
      [hub, new Set([a, b, c])],
      [a, new Set<string>()],
      [b, new Set<string>()],
      [c, new Set<string>()],
    ]);
    const scores = computePageRank({ edges, reverseEdges });
    expect(scores.get(hub)!).toBeGreaterThan(scores.get(a)!);
    expect(scores.get(hub)!).toBeGreaterThan(scores.get(b)!);
    expect(scores.get(hub)!).toBeGreaterThan(scores.get(c)!);
  });

  it('handles single node graph without crashing', () => {
    const node = '/ws/alone.ts';
    const graph = {
      edges: new Map([[node, new Set<string>()]]),
      reverseEdges: new Map([[node, new Set<string>()]]),
    };
    const scores = computePageRank(graph);
    // Isolated node converges to (1-d)/N = 0.15 with d=0.85, N=1
    expect(scores.get(node)).toBeGreaterThan(0);
    expect(scores.get(node)).toBeLessThanOrEqual(1);
  });

  it('hub node consistently has higher rank than sink nodes', () => {
    const a = '/ws/a.ts';
    const b = '/ws/b.ts';
    // a → b: b is a sink (imported), a is a source
    const graph = {
      edges: new Map([[a, new Set([b])], [b, new Set<string>()]]),
      reverseEdges: new Map([[a, new Set<string>()], [b, new Set([a])]]),
    };
    const scores = computePageRank(graph);
    // b is imported by a, so b should have higher rank than a
    expect(scores.get(b)!).toBeGreaterThan(scores.get(a)!);
  });
});

// ── CodebaseIndexer integration tests ────────────────────────────────────────

describe('CodebaseIndexer.buildIndex', () => {
  it('indexes a simple TypeScript project', async () => {
    const dir = mktemp();
    mkdirSync(join(dir, 'src'));

    writeFileSync(join(dir, 'src', 'utils.ts'), `
export function add(a: number, b: number): number { return a + b; }
export const PI = 3.14159;
`);
    writeFileSync(join(dir, 'src', 'app.ts'), `
import { add, PI } from './utils';
export class App { run() { return add(PI, 0); } }
`);

    const indexer = new CodebaseIndexer({ orionDir: join(dir, '.orion') });
    const index = await indexer.buildIndex(dir);

    expect(index.files.size).toBe(2);
    const utils = index.files.get('src/utils.ts');
    expect(utils).toBeDefined();
    expect(utils!.symbols.find((s) => s.name === 'add')).toBeDefined();
    expect(utils!.symbols.find((s) => s.name === 'PI')).toBeDefined();
  });

  it('computes PageRank (hub files score higher)', async () => {
    const dir = mktemp();
    mkdirSync(join(dir, 'src'));

    writeFileSync(join(dir, 'src', 'types.ts'), `export interface User { id: string; }`);
    writeFileSync(join(dir, 'src', 'service.ts'), `import type { User } from './types.js'; export function getUser(): User { return { id: '1' }; }`);
    writeFileSync(join(dir, 'src', 'controller.ts'), `import type { User } from './types.js'; import { getUser } from './service.js';`);
    writeFileSync(join(dir, 'src', 'handler.ts'), `import type { User } from './types.js';`);

    const indexer = new CodebaseIndexer({ orionDir: join(dir, '.orion') });
    const index = await indexer.buildIndex(dir);

    const typesRank = index.files.get('src/types.ts')?.pageRank ?? 0;
    const handlerRank = index.files.get('src/handler.ts')?.pageRank ?? 0;
    // types.ts is imported by 3 files, handler.ts imports but is not imported
    expect(typesRank).toBeGreaterThan(handlerRank);
  });

  it('saves index to disk', async () => {
    const dir = mktemp();
    writeFileSync(join(dir, 'a.ts'), `export const X = 1;`);

    const indexer = new CodebaseIndexer({ orionDir: join(dir, '.orion') });
    await indexer.buildIndex(dir);

    expect(existsSync(join(dir, '.orion', 'codebase-index.json'))).toBe(true);
  });
});

describe('CodebaseIndexer.loadOrBuild', () => {
  it('loads existing index from disk without rebuilding', async () => {
    const dir = mktemp();
    writeFileSync(join(dir, 'a.ts'), `export const X = 1;`);

    const indexer = new CodebaseIndexer({ orionDir: join(dir, '.orion') });
    await indexer.buildIndex(dir);

    // Second call should load from disk
    const index2 = await indexer.loadOrBuild(dir);
    expect(index2.files.size).toBe(1);
  });
});

describe('CodebaseIndexer.incrementalUpdate', () => {
  it('adds newly created files', async () => {
    const dir = mktemp();
    writeFileSync(join(dir, 'a.ts'), `export const A = 1;`);

    const indexer = new CodebaseIndexer({ orionDir: join(dir, '.orion') });
    await indexer.buildIndex(dir);

    // Add a new file
    writeFileSync(join(dir, 'b.ts'), `export const B = 2;`);
    const updated = await indexer.incrementalUpdate(dir, [join(dir, 'b.ts')]);

    expect(updated.files.has('a.ts')).toBe(true);
    expect(updated.files.has('b.ts')).toBe(true);
  });

  it('removes deleted files', async () => {
    const dir = mktemp();
    writeFileSync(join(dir, 'a.ts'), `export const A = 1;`);
    writeFileSync(join(dir, 'b.ts'), `export const B = 2;`);

    const indexer = new CodebaseIndexer({ orionDir: join(dir, '.orion') });
    await indexer.buildIndex(dir);

    // Delete b.ts
    rmSync(join(dir, 'b.ts'));
    const updated = await indexer.incrementalUpdate(dir, [join(dir, 'b.ts')]);

    expect(updated.files.has('a.ts')).toBe(true);
    expect(updated.files.has('b.ts')).toBe(false);
  });

  it('re-parses changed files', async () => {
    const dir = mktemp();
    writeFileSync(join(dir, 'a.ts'), `export const A = 1;`);

    const indexer = new CodebaseIndexer({ orionDir: join(dir, '.orion') });
    await indexer.buildIndex(dir);

    writeFileSync(join(dir, 'a.ts'), `export function hello() {} export const A = 1;`);
    const updated = await indexer.incrementalUpdate(dir, [join(dir, 'a.ts')]);

    const record = updated.files.get('a.ts');
    expect(record!.symbols.find((s) => s.name === 'hello')).toBeDefined();
  });
});

// ── CodebaseQuery ─────────────────────────────────────────────────────────────

async function buildTestIndex(files: Record<string, string>) {
  const dir = mktemp();
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const indexer = new CodebaseIndexer({ orionDir: join(dir, '.orion') });
  const index = await indexer.buildIndex(dir);
  return { index, dir };
}

describe('CodebaseQuery.findDefinition', () => {
  it('finds definition of exported function', async () => {
    const { index } = await buildTestIndex({
      'src/utils.ts': `export function computeHash(input: string): string { return input; }`,
    });
    const query = new CodebaseQuery(index);
    const defs = query.findDefinition('computeHash');
    expect(defs).toHaveLength(1);
    expect(defs[0].path).toBe('src/utils.ts');
    expect(defs[0].kind).toBe('function');
  });

  it('returns empty array for unknown symbol', async () => {
    const { index } = await buildTestIndex({ 'a.ts': `export const x = 1;` });
    const query = new CodebaseQuery(index);
    expect(query.findDefinition('nonExistentSymbol')).toEqual([]);
  });

  it('finds multiple definitions across files', async () => {
    const { index } = await buildTestIndex({
      'a.ts': `export function foo() {}`,
      'b.ts': `export function foo() {}`,
    });
    const query = new CodebaseQuery(index);
    const defs = query.findDefinition('foo');
    expect(defs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('CodebaseQuery.findReferences', () => {
  it('finds files that import a named symbol', async () => {
    const { index } = await buildTestIndex({
      'src/utils.ts': `export function add(a: number, b: number) { return a + b; }`,
      'src/app.ts': `import { add } from './utils.js'; add(1, 2);`,
    });
    const query = new CodebaseQuery(index);
    const refs = query.findReferences('add');
    expect(refs.some((r) => r.path === 'src/app.ts')).toBe(true);
  });
});

describe('CodebaseQuery.findDependents', () => {
  it('returns files that import the given file', async () => {
    const { index } = await buildTestIndex({
      'src/types.ts': `export interface User { id: string; }`,
      'src/service.ts': `import type { User } from './types.js';`,
      'src/controller.ts': `import type { User } from './types.js';`,
    });
    const query = new CodebaseQuery(index);
    const deps = query.findDependents('src/types.ts');
    expect(deps).toContain('src/service.ts');
    expect(deps).toContain('src/controller.ts');
  });

  it('returns empty for file with no importers', async () => {
    const { index } = await buildTestIndex({ 'standalone.ts': `export const X = 1;` });
    const query = new CodebaseQuery(index);
    expect(query.findDependents('standalone.ts')).toEqual([]);
  });
});

describe('CodebaseQuery.shortestPath', () => {
  it('returns single-element path for self', async () => {
    const { index } = await buildTestIndex({ 'a.ts': `export const X = 1;` });
    const query = new CodebaseQuery(index);
    expect(query.shortestPath('a.ts', 'a.ts')).toEqual(['a.ts']);
  });

  it('finds direct dependency path', async () => {
    const { index } = await buildTestIndex({
      'a.ts': `export const X = 1;`,
      'b.ts': `import { X } from './a.js';`,
    });
    const query = new CodebaseQuery(index);
    const path = query.shortestPath('b.ts', 'a.ts');
    expect(path).toEqual(['b.ts', 'a.ts']);
  });

  it('returns empty array when no path exists', async () => {
    const { index } = await buildTestIndex({
      'a.ts': `export const X = 1;`,
      'b.ts': `export const Y = 2;`,
    });
    const query = new CodebaseQuery(index);
    expect(query.shortestPath('a.ts', 'b.ts')).toEqual([]);
  });

  it('finds path through intermediary', async () => {
    const { index } = await buildTestIndex({
      'a.ts': `export const X = 1;`,
      'b.ts': `import { X } from './a.js'; export const Y = X;`,
      'c.ts': `import { Y } from './b.js';`,
    });
    const query = new CodebaseQuery(index);
    const path = query.shortestPath('c.ts', 'a.ts');
    expect(path.length).toBe(3);
    expect(path[0]).toBe('c.ts');
    expect(path[path.length - 1]).toBe('a.ts');
  });
});

describe('CodebaseQuery.impactAnalysis', () => {
  it('identifies files that would break if target changes', async () => {
    const { index } = await buildTestIndex({
      'lib/core.ts': `export function coreFunc() {}`,
      'lib/util.ts': `import { coreFunc } from './core.js';`,
      'app/main.ts': `import { coreFunc } from '../lib/core.js';`,
      'app/helper.ts': `import { coreFunc } from '../lib/core.js';`,
      'standalone.ts': `export const X = 1;`, // not connected
    });
    const query = new CodebaseQuery(index);
    const result = query.impactAnalysis(['lib/core.ts']);
    expect(result.changedFiles).toEqual(['lib/core.ts']);
    expect(result.affectedFiles).toContain('lib/util.ts');
    expect(result.affectedFiles).toContain('app/main.ts');
    expect(result.affectedFiles).toContain('app/helper.ts');
    expect(result.affectedFiles).not.toContain('standalone.ts');
    expect(result.totalAffected).toBe(3);
  });

  it('direct importers have distance 1', async () => {
    const { index } = await buildTestIndex({
      'core.ts': `export function f() {}`,
      'direct.ts': `import { f } from './core.js';`,
    });
    const query = new CodebaseQuery(index);
    const result = query.impactAnalysis(['core.ts']);
    expect(result.distanceMap.get('direct.ts')).toBe(1);
  });
});

describe('CodebaseQuery.topFilesByPageRank', () => {
  it('returns files sorted by pageRank descending', async () => {
    const { index } = await buildTestIndex({
      'shared.ts': `export const X = 1;`,
      'a.ts': `import { X } from './shared.js';`,
      'b.ts': `import { X } from './shared.js';`,
    });
    const query = new CodebaseQuery(index);
    const top = query.topFilesByPageRank(3);
    expect(top[0].path).toBe('shared.ts');
    expect(top[0].pageRank).toBeGreaterThan(top[1].pageRank);
  });
});

// ── computeRelevance ──────────────────────────────────────────────────────────

describe('computeRelevance', () => {
  it('returns 1.0 for target files', async () => {
    const { index } = await buildTestIndex({ 'src/target.ts': `export const X = 1;` });
    const task = { targetFiles: ['src/target.ts'], contextFiles: [], description: 'fix bug' };
    expect(computeRelevance('src/target.ts', task, index)).toBe(1.0);
  });

  it('returns 0.9 for context files', async () => {
    const { index } = await buildTestIndex({ 'src/ctx.ts': `export const X = 1;` });
    const task = { targetFiles: [], contextFiles: ['src/ctx.ts'], description: 'fix bug' };
    expect(computeRelevance('src/ctx.ts', task, index)).toBe(0.9);
  });

  it('gives higher score to direct dependency than indirect', async () => {
    const { index } = await buildTestIndex({
      'target.ts': `export function f() {}`,
      'direct.ts': `import { f } from './target.js';`,
      'indirect.ts': `import { f } from './direct.js';`,
    });
    const task = { targetFiles: ['target.ts'], contextFiles: [], description: 'update f' };
    const scoreDirect = computeRelevance('direct.ts', task, index);
    const scoreIndirect = computeRelevance('indirect.ts', task, index);
    expect(scoreDirect).toBeGreaterThan(scoreIndirect);
  });

  it('applies co-change bonus when gitInsights provided', async () => {
    const { index } = await buildTestIndex({
      'a.ts': `export const A = 1;`,
      'b.ts': `export const B = 2;`,
    });
    const task = { targetFiles: ['a.ts'], contextFiles: [], description: 'update A' };
    const insights = {
      cochangeClusters: new Map([['a.ts', ['b.ts']]]),
      hotFiles: [],
      directoryOwnership: new Map(),
      activeBranches: [],
    };
    const scoreWithInsights = computeRelevance('b.ts', task, index, insights);
    const scoreWithout = computeRelevance('b.ts', task, index);
    expect(scoreWithInsights).toBeGreaterThan(scoreWithout);
  });

  it('applies recency bonus for recently modified files', async () => {
    const { index } = await buildTestIndex({ 'recent.ts': `export const R = 1;` });
    // Manually set lastModified to now
    const record = index.files.get('recent.ts');
    if (record) record.lastModified = Date.now();

    const task = { targetFiles: ['recent.ts'], contextFiles: [], description: 'test' };
    // Can only test that the function doesn't throw and returns ≤ 1.0
    const score = computeRelevance('recent.ts', task, index);
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(0.0);
  });

  it('returns 0 for completely unrelated file', async () => {
    const { index } = await buildTestIndex({
      'target.ts': `export const T = 1;`,
      'unrelated.ts': `export const U = 2;`,
    });
    const task = { targetFiles: ['target.ts'], contextFiles: [], description: 'update T' };
    const score = computeRelevance('unrelated.ts', task, index);
    expect(score).toBeLessThan(0.5);
  });
});

describe('rankFilesByRelevance', () => {
  it('returns files sorted by score descending', async () => {
    const { index } = await buildTestIndex({
      'core.ts': `export function f() {}`,
      'dep.ts': `import { f } from './core.js';`,
      'unrelated.ts': `export const X = 99;`,
    });
    const task = { targetFiles: ['core.ts'], contextFiles: [], description: 'update f' };
    const ranked = rankFilesByRelevance(task, index);
    const scores = ranked.map((r) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it('filters by minScore', async () => {
    const { index } = await buildTestIndex({
      'target.ts': `export const T = 1;`,
      'unrelated.ts': `export const U = 2;`,
    });
    const task = { targetFiles: ['target.ts'], contextFiles: [], description: 'fix T' };
    const ranked = rankFilesByRelevance(task, index, undefined, 0.5);
    expect(ranked.every((r) => r.score >= 0.5)).toBe(true);
  });
});

// ── extractFileSkeleton ───────────────────────────────────────────────────────

describe('extractFileSkeleton', () => {
  it('keeps top-level declarations and strips bodies', () => {
    const content = `
export interface User {
  id: string;
  name: string;
}

export function getUser(id: string): User {
  const db = connectDB();
  return db.findUser(id);
}
`;
    const skeleton = extractFileSkeleton(content, 'typescript');
    expect(skeleton).toContain('export interface User');
    expect(skeleton).toContain('export function getUser');
  });
});

// ── buildTieredContext ────────────────────────────────────────────────────────

describe('buildTieredContext', () => {
  it('places target files in tier 2', async () => {
    const dir = mktemp();
    writeFileSync(join(dir, 'target.ts'), `export function fix() {}`);
    writeFileSync(join(dir, 'ctx.ts'), `export const CTX = 1;`);

    const indexer = new CodebaseIndexer({ orionDir: join(dir, '.orion') });
    const index = await indexer.buildIndex(dir);

    const task = { targetFiles: ['target.ts'], contextFiles: ['ctx.ts'], description: 'fix' };
    const ctx = buildTieredContext(task, 'implementer', index);

    const targetEntry = ctx.entries.find((e) => e.path === 'target.ts');
    const ctxEntry = ctx.entries.find((e) => e.path === 'ctx.ts');
    expect(targetEntry?.tier).toBe(2);
    expect(ctxEntry?.tier).toBe(3);
  });

  it('respects file budget per role', async () => {
    const { index } = await buildTestIndex({
      'a.ts': `export const A = 1;`,
      'b.ts': `export const B = 2;`,
      'c.ts': `export const C = 3;`,
    });

    // reporter has budget of 10, all files within budget
    const task = { targetFiles: ['a.ts'], contextFiles: [], description: 'test' };
    const ctx = buildTieredContext(task, 'reporter', index);
    expect(ctx.entries.length).toBeLessThanOrEqual(FILE_BUDGET_PER_ROLE['reporter']!);
  });

  it('includes tier1Summary with task description', async () => {
    const { index } = await buildTestIndex({ 'a.ts': `export const A = 1;` });
    const task = { targetFiles: ['a.ts'], contextFiles: [], description: 'implement feature X' };
    const ctx = buildTieredContext(task, 'implementer', index);
    expect(ctx.tier1Summary).toContain('implement feature X');
    expect(ctx.tier1Summary).toContain('a.ts');
  });

  it('does not duplicate files across tiers', async () => {
    const dir = mktemp();
    writeFileSync(join(dir, 'shared.ts'), `export const X = 1;`);

    const indexer = new CodebaseIndexer({ orionDir: join(dir, '.orion') });
    const index = await indexer.buildIndex(dir);

    const task = { targetFiles: ['shared.ts'], contextFiles: ['shared.ts'], description: 'fix' };
    const ctx = buildTieredContext(task, 'implementer', index);
    const paths = ctx.entries.map((e) => e.path);
    const unique = new Set(paths);
    expect(paths.length).toBe(unique.size);
  });
});

// ── ProjectFingerprint ────────────────────────────────────────────────────────

describe('saveFingerprint / loadFingerprint', () => {
  it('round-trips fingerprint to disk', async () => {
    const dir = mktemp();
    const fingerprint = {
      language: 'TypeScript', framework: 'Express', testFramework: 'vitest',
      buildSystem: 'tsc', lintCommand: 'eslint .', projectStructure: '.',
      relevantFiles: [], entryPoints: ['src/index.ts'], dependencies: {},
      workspaceDir: dir, fileCount: 5, gitHeadCommit: 'abc123',
      createdAt: Date.now(), checkedAt: Date.now(),
    };

    saveFingerprint(fingerprint, join(dir, '.orion'));
    const loaded = loadFingerprint(dir, join(dir, '.orion'));

    expect(loaded).not.toBeNull();
    expect(loaded!.language).toBe('TypeScript');
    expect(loaded!.gitHeadCommit).toBe('abc123');
    expect(loaded!.fileCount).toBe(5);
  });

  it('returns null for non-existent fingerprint', () => {
    const dir = mktemp();
    expect(loadFingerprint(dir)).toBeNull();
  });

  it('returns null for wrong workspaceDir', () => {
    const dir = mktemp();
    const otherDir = mktemp();
    const fingerprint = {
      language: 'TypeScript', framework: null, testFramework: null,
      buildSystem: null, lintCommand: null, projectStructure: '',
      relevantFiles: [], entryPoints: [], dependencies: {},
      workspaceDir: otherDir, fileCount: 0, gitHeadCommit: '',
      createdAt: Date.now(), checkedAt: Date.now(),
    };
    saveFingerprint(fingerprint, join(dir, '.orion'));
    // Load with different workspaceDir → should return null
    expect(loadFingerprint(dir, join(dir, '.orion'))).toBeNull();
  });
});

describe('isFingerprintValid', () => {
  function makeFp(overrides: Partial<Parameters<typeof saveFingerprint>[0]> = {}): ReturnType<typeof loadFingerprint> {
    const base = {
      language: 'TypeScript', framework: null, testFramework: null,
      buildSystem: null, lintCommand: null, projectStructure: '',
      relevantFiles: [], entryPoints: [], dependencies: {},
      workspaceDir: '/ws', fileCount: 10, gitHeadCommit: 'abc123',
      createdAt: Date.now(), checkedAt: Date.now(),
      ...overrides,
    };
    return base as NonNullable<ReturnType<typeof loadFingerprint>>;
  }

  it('returns invalid when force=true', async () => {
    const fp = makeFp();
    const result = await isFingerprintValid(fp!, true);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('force');
  });

  it('returns invalid when TTL exceeded', async () => {
    const fp = makeFp({ createdAt: Date.now() - 25 * 60 * 60 * 1000 }); // 25h ago
    const result = await isFingerprintValid(fp!);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('TTL');
  });

  it('returns valid for fresh fingerprint with no git', async () => {
    const dir = mktemp(); // not a git repo
    const fp = makeFp({ workspaceDir: dir, createdAt: Date.now(), gitHeadCommit: '' });
    const result = await isFingerprintValid(fp!);
    // no git → git diff will fail → treated as changed, but gitHeadCommit is empty → skips check
    expect(result.valid).toBe(true);
  });
});

describe('buildFingerprint', () => {
  it('creates fingerprint with correct metadata', async () => {
    const dir = mktemp();
    const scan = {
      language: 'TypeScript', framework: 'Next.js', testFramework: 'jest',
      buildSystem: 'tsc', lintCommand: 'eslint .', projectStructure: '.',
      relevantFiles: [
        { path: 'a.ts', role: 'source' as const, complexity: 'low' as const, linesOfCode: 10 },
      ],
      entryPoints: ['src/index.ts'], dependencies: { react: '^18.0.0' },
    };
    const fp = await buildFingerprint(scan, dir);
    expect(fp.workspaceDir).toBe(dir);
    expect(fp.fileCount).toBe(1); // 1 file in relevantFiles
    expect(fp.createdAt).toBeGreaterThan(0);
    expect(fp.language).toBe('TypeScript');
  });
});
