/**
 * @module orchestration/coding/codebase-indexer
 * Three-layer hybrid codebase index (Section 6.1 of spec).
 *
 * Layer 1: Structural Index — regex-based symbol + import extraction
 * Layer 2: Dependency Graph  — per-file import adjacency list + PageRank
 * Layer 3: Semantic Index    — interface placeholder (embeddings-optional)
 *
 * Storage: JSON file at {workspaceDir}/.orion/codebase-index.json
 * (better-sqlite3 can be swapped in later without changing the public API)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, relative, extname, dirname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('codebase-indexer');

// ── Language detection ────────────────────────────────────────────────────────

/** File extension → language name map. */
const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.lua': 'lua',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.r': 'r',
  '.jl': 'julia',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.ml': 'ocaml',
  '.hs': 'haskell',
  '.vue': 'typescript',
  '.svelte': 'typescript',
  '.astro': 'typescript',
};

/** Directories always skipped during discovery. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.turbo',
  'target', '__pycache__', '.venv', 'venv', '.tox', '.eggs',
  'vendor', '.cache', 'coverage', '.nyc_output', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', 'out', '.output', '.orion',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

/** A symbol extracted from a source file. */
export interface SymbolInfo {
  /** Symbol name. */
  name: string;
  /** Kind of symbol. */
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum' | 'method' | 'variable';
  /** 1-based line number where the symbol is defined. */
  line: number;
  /** Whether the symbol is exported. */
  exported: boolean;
}

/** An import statement extracted from a source file. */
export interface ImportInfo {
  /** The raw module specifier from the source (e.g. './utils', 'lodash'). */
  source: string;
  /** Resolved absolute path (for relative/workspace imports; null for packages). */
  resolved: string | null;
  /** Named symbols imported, or ['*'] for namespace imports, ['default'] for defaults. */
  symbols: string[];
  /** 1-based line number of the import statement. */
  line: number;
}

/** Per-file record stored in the index. */
export interface FileRecord {
  /** Path relative to workspace root. */
  path: string;
  /** Detected programming language. */
  language: string;
  /** Symbols defined in this file. */
  symbols: SymbolInfo[];
  /** Import statements in this file. */
  imports: ImportInfo[];
  /** PageRank relevance score (updated after graph build). */
  pageRank: number;
  /** File modification time (ms since epoch). */
  lastModified: number;
  /** SHA-256 hash of file content (first 8KB) for change detection. */
  hash: string;
  /** Line count. */
  lineCount: number;
}

/** Dependency graph built from import statements. */
export interface DependencyGraph {
  /** Forward edges: file path → set of files it imports (resolved paths only). */
  edges: Map<string, Set<string>>;
  /** Reverse edges: file path → set of files that import it. */
  reverseEdges: Map<string, Set<string>>;
}

/** The full in-memory index. */
export interface CodebaseIndex {
  /** Workspace directory (absolute). */
  workspaceDir: string;
  /** File records keyed by relative path. */
  files: Map<string, FileRecord>;
  /** Dependency graph (absolute paths). */
  depGraph: DependencyGraph;
  /** Timestamp of when the index was last built. */
  updatedAt: number;
}

/** Serialised form stored on disk. */
interface IndexData {
  version: 2;
  workspaceDir: string;
  createdAt: number;
  updatedAt: number;
  files: Record<string, FileRecord>;
}

/** Semantic index placeholder — interface for future embedding-based search. */
export interface SemanticIndex {
  /** Find top-K files/chunks by natural-language similarity. */
  query(text: string, topK: number): Promise<Array<{ path: string; score: number; snippet: string }>>;
  /** Re-embed a set of files (called after incremental update). */
  updateFiles(paths: string[]): Promise<void>;
}

// ── Gitignore helpers ─────────────────────────────────────────────────────────

function loadGitignorePatterns(dir: string): (name: string, isDir: boolean) => boolean {
  const gitignorePath = join(dir, '.gitignore');
  if (!existsSync(gitignorePath)) return () => false;
  try {
    const lines = readFileSync(gitignorePath, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
    return (name: string, isDir: boolean): boolean => {
      for (const pattern of lines) {
        const clean = pattern.replace(/\/+$/, '');
        if (clean === name) return true;
        if (isDir && clean.endsWith('/*') && name === clean.slice(0, -2)) return true;
        if (clean.startsWith('*') && name.endsWith(clean.slice(1))) return true;
        if (clean.includes('/') && name === basename(clean)) return true;
      }
      return false;
    };
  } catch {
    return () => false;
  }
}

// ── Source file discovery ─────────────────────────────────────────────────────

/**
 * Recursively discover all source files in a workspace directory,
 * respecting .gitignore patterns and SKIP_DIRS.
 *
 * @returns Absolute paths to source files.
 */
export function discoverSourceFiles(workspaceDir: string): string[] {
  const files: string[] = [];
  const gitignoreFilter = loadGitignorePatterns(workspaceDir);

  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.env.example') continue;
      const fullPath = join(dir, entry);
      let isDir = false;
      try {
        const st = statSync(fullPath);
        isDir = st.isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (SKIP_DIRS.has(entry)) continue;
        if (gitignoreFilter(entry, true)) continue;
        walk(fullPath, depth + 1);
      } else {
        if (gitignoreFilter(entry, false)) continue;
        const ext = extname(entry).toLowerCase();
        if (EXT_TO_LANGUAGE[ext]) {
          files.push(fullPath);
        }
      }
    }
  };

  walk(workspaceDir, 0);
  return files;
}

// ── Language detection ────────────────────────────────────────────────────────

/**
 * Detect the programming language of a file based on its extension.
 */
export function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? 'unknown';
}

// ── Symbol extraction ─────────────────────────────────────────────────────────

/** Patterns for symbol extraction per language family. */
const SYMBOL_PATTERNS: Record<string, Array<{ re: RegExp; kind: SymbolInfo['kind']; exportedGroup?: number }>> = {
  typescript: [
    // export function / export async function
    { re: /^(export\s+default\s+|export\s+)?(?:async\s+)?function\s+(\w+)/gm, kind: 'function', exportedGroup: 1 },
    // export class / export abstract class
    { re: /^(export\s+default\s+|export\s+)?(?:abstract\s+)?class\s+(\w+)/gm, kind: 'class', exportedGroup: 1 },
    // export interface
    { re: /^(export\s+)?interface\s+(\w+)/gm, kind: 'interface', exportedGroup: 1 },
    // export type Name =
    { re: /^(export\s+)?type\s+(\w+)\s*(?:<[^=]*>)?\s*=/gm, kind: 'type', exportedGroup: 1 },
    // export const/let/var (function or non-function assignment)
    { re: /^(export\s+)(?:const|let|var)\s+(\w+)/gm, kind: 'const', exportedGroup: 1 },
    // const/let/var at top level (exported arrow fn heuristic)
    { re: /^(?:const|let|var)\s+(\w+)\s*(?::\s*[^=\n]+)?\s*=\s*(?:async\s*)?\(/gm, kind: 'const' },
    // export enum
    { re: /^(export\s+)?(?:const\s+)?enum\s+(\w+)/gm, kind: 'enum', exportedGroup: 1 },
    // class methods: public/private/protected/static/async + name(
    { re: /^\s+(?:(?:public|private|protected|static|readonly|override|abstract)\s+)*(?:async\s+)?(\w+)\s*(?:<[^(]*>)?\s*\(/gm, kind: 'method' },
  ],
  python: [
    { re: /^def\s+(\w+)/gm, kind: 'function' },
    { re: /^async\s+def\s+(\w+)/gm, kind: 'function' },
    { re: /^class\s+(\w+)/gm, kind: 'class' },
    // decorated function (@decorator\ndef name)
    { re: /^@\w[^\n]*\n(?:async\s+)?def\s+(\w+)/gm, kind: 'function' },
  ],
  go: [
    { re: /^func\s+(?:\([^)]+\)\s+)?([A-Za-z]\w*)/gm, kind: 'function' },
    { re: /^type\s+([A-Za-z]\w*)\s+(?:struct|interface)/gm, kind: 'class' },
  ],
  rust: [
    { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/gm, kind: 'function' },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/gm, kind: 'class' },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/gm, kind: 'interface' },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/gm, kind: 'enum' },
  ],
  java: [
    { re: /^(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?class\s+(\w+)/gm, kind: 'class' },
    { re: /^(?:public|protected|private)?\s*interface\s+(\w+)/gm, kind: 'interface' },
    { re: /^(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:\w+\s+)+(\w+)\s*\(/gm, kind: 'function' },
  ],
};

// TypeScript shares patterns with JavaScript
SYMBOL_PATTERNS['javascript'] = SYMBOL_PATTERNS['typescript'];
SYMBOL_PATTERNS['kotlin'] = SYMBOL_PATTERNS['java'];

/**
 * Extract symbol definitions from file content using regex-based parsing.
 * Returns function/class/interface/type/const/enum declarations.
 */
export function extractSymbols(content: string, language: string): SymbolInfo[] {
  const patterns = SYMBOL_PATTERNS[language];
  if (!patterns) return [];

  const symbols: SymbolInfo[] = [];
  const seen = new Set<string>();
  const lines = content.split('\n');

  for (const { re, kind, exportedGroup } of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      // For patterns without exportedGroup, the first group IS the name
      let name: string;
      let exported = false;

      if (exportedGroup !== undefined) {
        // Group 1 = export prefix, group 2 = name
        exported = Boolean(match[1] && match[1].trim().startsWith('export'));
        name = match[2];
      } else {
        // Single capture group: name is match[1]
        name = match[1];
        // Methods are never "exported" in the JS sense
        exported = kind !== 'method';
      }

      if (!name || name === 'if' || name === 'for' || name === 'while' || name === 'switch' ||
          name === 'return' || name === 'else' || name === 'new' || name === 'this' ||
          name === 'constructor' || name === 'super') {
        continue;
      }

      // Compute line number from match index
      const matchIndex = match.index;
      let line = 1;
      let pos = 0;
      for (let i = 0; i < lines.length; i++) {
        if (pos + lines[i].length >= matchIndex) {
          line = i + 1;
          break;
        }
        pos += lines[i].length + 1; // +1 for \n
      }

      const key = `${kind}:${name}:${line}`;
      if (!seen.has(key)) {
        seen.add(key);
        symbols.push({ name, kind, line, exported });
      }
    }
  }

  // Sort by line number
  symbols.sort((a, b) => a.line - b.line);
  return symbols;
}

// ── Import extraction ─────────────────────────────────────────────────────────

/**
 * Extract import statements from file content.
 * Handles TypeScript/JS, Python, Go, and Rust.
 */
export function extractImports(content: string, language: string, filePath: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const lines = content.split('\n');

  if (language === 'typescript' || language === 'javascript') {
    extractJSImports(content, lines, imports);
  } else if (language === 'python') {
    extractPythonImports(lines, imports, filePath);
  } else if (language === 'go') {
    extractGoImports(content, lines, imports);
  } else if (language === 'rust') {
    extractRustImports(lines, imports);
  }

  return imports;
}

function lineOf(content: string, lines: string[], matchIndex: number): number {
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    if (pos + lines[i].length >= matchIndex) return i + 1;
    pos += lines[i].length + 1;
  }
  return lines.length;
}

function extractJSImports(content: string, lines: string[], imports: ImportInfo[]): void {
  // import { A, B as C } from 'path'
  // import type { A } from 'path'
  // import * as X from 'path'
  // import X from 'path'
  // import 'path'
  const staticRe = /^import\s+(?:type\s+)?(?:(\{[^}]*\})|(\*\s+as\s+\w+)|([\w$]+(?:\s*,\s*\{[^}]*\})?))\s+from\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  staticRe.lastIndex = 0;
  while ((m = staticRe.exec(content)) !== null) {
    const src = m[4];
    const symbols = parseJSSymbolList(m[1] ?? m[2] ?? m[3] ?? '');
    imports.push({ source: src, resolved: null, symbols, line: lineOf(content, lines, m.index) });
  }

  // import 'path' (side-effect)
  const sideEffectRe = /^import\s+['"]([^'"]+)['"]/gm;
  sideEffectRe.lastIndex = 0;
  while ((m = sideEffectRe.exec(content)) !== null) {
    imports.push({ source: m[1], resolved: null, symbols: [], line: lineOf(content, lines, m.index) });
  }

  // export { A } from 'path'
  // export * from 'path'
  const reexportRe = /^export\s+(?:type\s+)?(?:(\{[^}]*\})|\*(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/gm;
  reexportRe.lastIndex = 0;
  while ((m = reexportRe.exec(content)) !== null) {
    const src = m[2];
    const symbols = m[1] ? parseJSSymbolList(m[1]) : ['*'];
    imports.push({ source: src, resolved: null, symbols, line: lineOf(content, lines, m.index) });
  }

  // require('path')
  const requireRe = /(?:^|[^\w$])require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
  requireRe.lastIndex = 0;
  while ((m = requireRe.exec(content)) !== null) {
    imports.push({ source: m[1], resolved: null, symbols: ['*'], line: lineOf(content, lines, m.index) });
  }

  // dynamic import('path')
  const dynImportRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
  dynImportRe.lastIndex = 0;
  while ((m = dynImportRe.exec(content)) !== null) {
    imports.push({ source: m[1], resolved: null, symbols: ['*'], line: lineOf(content, lines, m.index) });
  }
}

function parseJSSymbolList(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  if (s.startsWith('* as')) return ['*'];
  if (s.startsWith('{')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((p) => p.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
  }
  // Default import (may be followed by comma + named)
  const parts = s.split(',');
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (t.startsWith('{')) {
      out.push(...t.slice(1, -1).split(',').map((x) => x.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
    } else if (t) {
      out.push('default');
    }
  }
  return out.length ? out : ['default'];
}

function extractPythonImports(lines: string[], imports: ImportInfo[], filePath: string): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNum = i + 1;

    // from .module import A, B
    const fromRe = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(line);
    if (fromRe) {
      const src = fromRe[1];
      const syms = fromRe[2].split(',').map((s) => s.trim().split(' as ')[0].trim()).filter(Boolean);
      imports.push({ source: src, resolved: null, symbols: syms, line: lineNum });
      continue;
    }

    // import module
    const importRe = /^import\s+([\w., ]+)$/.exec(line);
    if (importRe) {
      const modules = importRe[1].split(',').map((s) => s.trim().split(' as ')[0].trim()).filter(Boolean);
      for (const mod of modules) {
        imports.push({ source: mod, resolved: null, symbols: ['*'], line: lineNum });
      }
    }
  }
}

function extractGoImports(content: string, lines: string[], imports: ImportInfo[]): void {
  // import "path"
  const singleRe = /^\s*import\s+"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  singleRe.lastIndex = 0;
  while ((m = singleRe.exec(content)) !== null) {
    imports.push({ source: m[1], resolved: null, symbols: ['*'], line: lineOf(content, lines, m.index) });
  }
  // import ( "path" ) block
  const blockRe = /import\s*\(([^)]*)\)/gs;
  blockRe.lastIndex = 0;
  while ((m = blockRe.exec(content)) !== null) {
    const block = m[1];
    const lineStart = lineOf(content, lines, m.index);
    const pathRe = /"([^"]+)"/g;
    let pm: RegExpExecArray | null;
    while ((pm = pathRe.exec(block)) !== null) {
      imports.push({ source: pm[1], resolved: null, symbols: ['*'], line: lineStart });
    }
  }
}

function extractRustImports(lines: string[], imports: ImportInfo[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const useRe = /^use\s+([\w:{}*, ]+)\s*;/.exec(line);
    if (useRe) {
      const path = useRe[1].split('::')[0].trim();
      imports.push({ source: path, resolved: null, symbols: ['*'], line: i + 1 });
    }
  }
}

// ── Path resolution ───────────────────────────────────────────────────────────

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.py'];

/**
 * Attempt to resolve a relative/local import specifier to an absolute file path.
 * Returns null if the specifier is a package import or can't be resolved.
 */
export function resolveImportPath(specifier: string, fromFile: string, workspaceDir: string): string | null {
  // Skip package imports (no leading . or /)
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;

  const fromDir = dirname(fromFile);
  const candidate = resolve(fromDir, specifier);

  // Try the path as-is
  if (existsSync(candidate)) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* ignore */ }
  }

  // Try with common extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = candidate + ext;
    if (existsSync(withExt)) return withExt;
  }

  // Try index files
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexFile = join(candidate, `index${ext}`);
    if (existsSync(indexFile)) return indexFile;
  }

  // Handle .js → .ts remapping (TypeScript projects use .js in imports)
  if (candidate.endsWith('.js')) {
    const asTs = candidate.slice(0, -3) + '.ts';
    if (existsSync(asTs)) return asTs;
    const asTsx = candidate.slice(0, -3) + '.tsx';
    if (existsSync(asTsx)) return asTsx;
  }

  return null;
}

// ── Dependency graph ──────────────────────────────────────────────────────────

/**
 * Build a dependency graph from the set of file records.
 * Resolves relative import paths to actual file paths.
 */
export function buildDependencyGraph(
  files: Map<string, FileRecord>,
  workspaceDir: string,
): DependencyGraph {
  const edges = new Map<string, Set<string>>();
  const reverseEdges = new Map<string, Set<string>>();

  // Initialise empty sets for all known files
  for (const relPath of files.keys()) {
    const abs = join(workspaceDir, relPath);
    edges.set(abs, new Set());
    reverseEdges.set(abs, new Set());
  }

  // Build a lookup from absolute path → relative path
  const absToRel = new Map<string, string>();
  for (const relPath of files.keys()) {
    absToRel.set(join(workspaceDir, relPath), relPath);
  }

  for (const [relPath, record] of files.entries()) {
    const absFrom = join(workspaceDir, relPath);
    for (const imp of record.imports) {
      // Prefer the already-resolved path; fall back to on-demand resolution
      const resolved = imp.resolved ?? resolveImportPath(imp.source, absFrom, workspaceDir);
      if (resolved && absToRel.has(resolved)) {
        if (!edges.has(absFrom)) edges.set(absFrom, new Set());
        edges.get(absFrom)!.add(resolved);
        if (!reverseEdges.has(resolved)) reverseEdges.set(resolved, new Set());
        reverseEdges.get(resolved)!.add(absFrom);
      }
    }
  }

  return { edges, reverseEdges };
}

// ── PageRank ──────────────────────────────────────────────────────────────────

const PAGERANK_DAMPING = 0.85;
const PAGERANK_ITERATIONS = 50;
const PAGERANK_EPSILON = 1e-6;

/**
 * Compute PageRank scores for all files in the dependency graph.
 *
 * Files imported by many others receive higher scores (they are "hub" files).
 * Uses the standard iterative power-method with damping factor 0.85.
 *
 * @returns Map from absolute file path to PageRank score.
 */
export function computePageRank(graph: DependencyGraph): Map<string, number> {
  const nodes = Array.from(graph.edges.keys());
  const N = nodes.length;
  if (N === 0) return new Map();

  const initialScore = 1 / N;
  const scores = new Map<string, number>(nodes.map((n) => [n, initialScore]));
  const outDegree = new Map<string, number>(nodes.map((n) => [n, graph.edges.get(n)?.size ?? 0]));

  for (let iter = 0; iter < PAGERANK_ITERATIONS; iter++) {
    const newScores = new Map<string, number>();
    let delta = 0;

    for (const node of nodes) {
      // Sum contributions from all nodes that link TO this node (via reverseEdges)
      let rank = (1 - PAGERANK_DAMPING) / N;
      const incomingNodes = graph.reverseEdges.get(node) ?? new Set();
      for (const incoming of incomingNodes) {
        const od = outDegree.get(incoming) ?? 1;
        rank += PAGERANK_DAMPING * (scores.get(incoming) ?? 0) / od;
      }
      newScores.set(node, rank);
      delta += Math.abs(rank - (scores.get(node) ?? 0));
    }

    for (const [node, score] of newScores) {
      scores.set(node, score);
    }

    if (delta < PAGERANK_EPSILON) break;
  }

  return scores;
}

// ── Content hashing ───────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return createHash('sha256').update(content.slice(0, 8192)).digest('hex').slice(0, 16);
}

// ── CodebaseIndexer ───────────────────────────────────────────────────────────

const INDEX_FILE = 'codebase-index.json';
const INDEX_VERSION = 2;
const MAX_FILE_SIZE = 500_000; // 500 KB — skip larger files

/** Options for CodebaseIndexer. */
export interface CodebaseIndexerOptions {
  /** Maximum file size to index (bytes). Default: 500 KB. */
  maxFileSizeBytes?: number;
  /** Enable semantic index (placeholder; requires external embeddings API). */
  enableEmbeddings?: boolean;
  /** Override for .orion directory path. Defaults to {workspaceDir}/.orion. */
  orionDir?: string;
}

/**
 * Builds and maintains a three-layer hybrid codebase index:
 *  - Structural (symbols + imports per file)
 *  - Dependency graph (import relationships + PageRank)
 *  - Semantic (interface only; embeddings optional)
 */
export class CodebaseIndexer {
  private options: Required<CodebaseIndexerOptions>;

  constructor(options: CodebaseIndexerOptions = {}) {
    this.options = {
      maxFileSizeBytes: options.maxFileSizeBytes ?? MAX_FILE_SIZE,
      enableEmbeddings: options.enableEmbeddings ?? false,
      orionDir: options.orionDir ?? '',
    };
  }

  /** Build a full index from scratch for the given workspace. */
  async buildIndex(workspaceDir: string): Promise<CodebaseIndex> {
    log.info('Building full codebase index', { workspaceDir });
    const start = Date.now();

    const allFiles = discoverSourceFiles(workspaceDir);
    log.info(`Discovered ${allFiles.length} source files`);

    const fileRecords = new Map<string, FileRecord>();
    for (const absPath of allFiles) {
      const record = this.indexFile(absPath, workspaceDir);
      if (record) {
        fileRecords.set(record.path, record);
      }
    }

    // Resolve import paths
    this.resolveImports(fileRecords, workspaceDir);

    const depGraph = buildDependencyGraph(fileRecords, workspaceDir);
    const pageRanks = computePageRank(depGraph);

    // Write PageRank scores back into file records
    for (const [relPath, record] of fileRecords.entries()) {
      const absPath = join(workspaceDir, relPath);
      record.pageRank = pageRanks.get(absPath) ?? 0;
    }

    const now = Date.now();
    const index: CodebaseIndex = {
      workspaceDir,
      files: fileRecords,
      depGraph,
      updatedAt: now,
    };

    this.saveIndex(workspaceDir, fileRecords, now, now);
    log.info(`Index built in ${Date.now() - start}ms`, { files: fileRecords.size });
    return index;
  }

  /**
   * Incrementally update the index for a set of changed files.
   * Only re-parses changed files; updates the dependency graph and PageRank.
   */
  async incrementalUpdate(workspaceDir: string, changedFiles: string[]): Promise<CodebaseIndex> {
    log.info(`Incremental update: ${changedFiles.length} changed files`);

    const existing = this.loadFromDisk(workspaceDir);
    const fileRecords: Map<string, FileRecord> = existing
      ? new Map(Object.entries(existing.files))
      : new Map();

    for (const absPath of changedFiles) {
      const relPath = relative(workspaceDir, absPath);
      if (!existsSync(absPath)) {
        // File was deleted
        fileRecords.delete(relPath);
        continue;
      }
      const record = this.indexFile(absPath, workspaceDir);
      if (record) {
        fileRecords.set(record.path, record);
      }
    }

    // Re-resolve imports for changed files only
    this.resolveImports(fileRecords, workspaceDir);

    const depGraph = buildDependencyGraph(fileRecords, workspaceDir);
    const pageRanks = computePageRank(depGraph);

    for (const [relPath, record] of fileRecords.entries()) {
      const absPath = join(workspaceDir, relPath);
      record.pageRank = pageRanks.get(absPath) ?? 0;
    }

    const now = Date.now();
    const createdAt = existing?.createdAt ?? now;
    this.saveIndex(workspaceDir, fileRecords, createdAt, now);

    return {
      workspaceDir,
      files: fileRecords,
      depGraph,
      updatedAt: now,
    };
  }

  /**
   * Load an existing index from disk, or build a fresh one if none exists.
   */
  async loadOrBuild(workspaceDir: string): Promise<CodebaseIndex> {
    const existing = this.loadFromDisk(workspaceDir);
    if (existing) {
      log.info('Loaded existing index from disk', { files: Object.keys(existing.files).length });
      const fileRecords = new Map<string, FileRecord>(Object.entries(existing.files));
      const depGraph = buildDependencyGraph(fileRecords, workspaceDir);
      return { workspaceDir, files: fileRecords, depGraph, updatedAt: existing.updatedAt };
    }
    return this.buildIndex(workspaceDir);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private indexFile(absPath: string, workspaceDir: string): FileRecord | null {
    let content: string;
    try {
      const st = statSync(absPath);
      if (st.size > this.options.maxFileSizeBytes) return null;
      content = readFileSync(absPath, 'utf-8');
    } catch {
      return null;
    }

    const relPath = relative(workspaceDir, absPath);
    const language = detectLanguage(absPath);
    const symbols = extractSymbols(content, language);
    const imports = extractImports(content, language, absPath);
    const lineCount = content.split('\n').length;

    let lastModified = 0;
    try {
      lastModified = statSync(absPath).mtimeMs;
    } catch { /* ignore */ }

    return {
      path: relPath,
      language,
      symbols,
      imports,
      pageRank: 0,
      lastModified,
      hash: hashContent(content),
      lineCount,
    };
  }

  private resolveImports(fileRecords: Map<string, FileRecord>, workspaceDir: string): void {
    for (const [relPath, record] of fileRecords.entries()) {
      const absPath = join(workspaceDir, relPath);
      for (const imp of record.imports) {
        if (!imp.resolved) {
          const resolved = resolveImportPath(imp.source, absPath, workspaceDir);
          if (resolved) imp.resolved = resolved;
        }
      }
    }
  }

  private getOrionDir(workspaceDir: string): string {
    return this.options.orionDir || join(workspaceDir, '.orion');
  }

  private saveIndex(
    workspaceDir: string,
    files: Map<string, FileRecord>,
    createdAt: number,
    updatedAt: number,
  ): void {
    const orionDir = this.getOrionDir(workspaceDir);
    try {
      mkdirSync(orionDir, { recursive: true });
      const data: IndexData = {
        version: INDEX_VERSION,
        workspaceDir,
        createdAt,
        updatedAt,
        files: Object.fromEntries(files.entries()),
      };
      writeFileSync(join(orionDir, INDEX_FILE), JSON.stringify(data), 'utf-8');
    } catch (err) {
      log.warn('Failed to save index to disk', { err });
    }
  }

  private loadFromDisk(workspaceDir: string): IndexData | null {
    const indexPath = join(this.getOrionDir(workspaceDir), INDEX_FILE);
    if (!existsSync(indexPath)) return null;
    try {
      const raw = readFileSync(indexPath, 'utf-8');
      const data = JSON.parse(raw) as IndexData;
      if (data.version !== INDEX_VERSION) return null;
      if (data.workspaceDir !== workspaceDir) return null;
      return data;
    } catch {
      return null;
    }
  }
}
