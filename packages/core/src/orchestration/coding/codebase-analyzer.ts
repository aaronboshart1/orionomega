/**
 * @module orchestration/coding/codebase-analyzer
 * Codebase analysis for Coding Mode.
 *
 * Provides functions to scan directory trees (respecting .gitignore), build
 * file tree representations, read and summarize key project files, identify
 * the tech stack, and generate an architecture summary.
 *
 * Used by the codebase-scanner node to produce a CodebaseScanOutput before
 * the architect node begins planning.
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodebaseScanOutput } from './coding-types.js';
import { createLogger } from '../../logging/logger.js';

const _execAsync = promisify(execCb);
const log = createLogger('codebase-analyzer');

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single node in the file tree representation. */
export interface FileTreeNode {
  /** File or directory name. */
  name: string;
  /** Absolute path. */
  path: string;
  /** 'file' or 'directory'. */
  type: 'file' | 'directory';
  /** File size in bytes (files only). */
  size?: number;
  /** Children (directories only). */
  children?: FileTreeNode[];
  /** File extension (files only, e.g. '.ts'). */
  ext?: string;
}

/** Summary of a key project file. */
export interface KeyFileSummary {
  /** Relative path to the file from the project root. */
  path: string;
  /** Type of key file. */
  kind: 'package.json' | 'readme' | 'config' | 'lock' | 'ci' | 'other';
  /** Parsed content (for JSON files) or raw text (truncated). */
  content: string;
}

/** Detected tech stack. */
export interface TechStack {
  /** Primary programming language (TypeScript, JavaScript, Python, Go, Rust, Java, etc.). */
  language: string;
  /** Frontend/backend framework (Next.js, Express, FastAPI, etc.). */
  framework: string | null;
  /** Test framework (jest, vitest, pytest, go test, etc.). */
  testFramework: string | null;
  /** Build system (tsc, webpack, vite, cargo, go build, etc.). */
  buildSystem: string | null;
  /** Detected lint command (eslint, ruff, golint, etc.). */
  lintCommand: string | null;
  /** Package manager (npm, pnpm, yarn, pip, cargo, etc.). */
  packageManager: string | null;
  /** Runtime dependencies (name → version). */
  dependencies: Record<string, string>;
  /** Dev dependencies (name → version). */
  devDependencies: Record<string, string>;
}

/** Full architecture summary produced by analyzeCodebase. */
export interface ArchitectureSummary {
  /** Detected tech stack. */
  techStack: TechStack;
  /** Human-readable file tree (indented text, trimmed to a reasonable depth). */
  projectStructure: string;
  /** Key files with summaries. */
  keyFiles: KeyFileSummary[];
  /** Application entry points (relative paths). */
  entryPoints: string[];
  /** Relevant source files for the given task. */
  relevantFiles: CodebaseScanOutput['relevantFiles'];
  /** Total file count (excluding .gitignore'd and node_modules). */
  totalFiles: number;
  /** Total lines of code estimate. */
  estimatedLoc: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Directories to always skip during scanning. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.turbo',
  'target', '__pycache__', '.venv', 'venv', '.tox', '.eggs',
  'vendor', '.cache', 'coverage', '.nyc_output', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', 'out', '.output',
]);

/** Extensions considered source code. */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift',
  '.rb', '.php', '.lua', '.sh', '.bash', '.zsh',
  '.r', '.jl', '.ex', '.exs', '.ml', '.hs',
  '.vue', '.svelte', '.astro',
]);

/** Max files to include in the relevantFiles list. */
const MAX_RELEVANT_FILES = 50;
/** Max depth for tree rendering. */
const MAX_TREE_DEPTH = 4;
/** Max bytes to read from a text file for summary. */
const MAX_FILE_READ_BYTES = 50_000;

// ── .gitignore parsing ───────────────────────────────────────────────────────

/**
 * Parse .gitignore patterns from a directory into a simple filter function.
 * Only handles the most common patterns (globs, negation not supported).
 * @internal
 */
function loadGitignorePatterns(dir: string): (name: string, isDir: boolean) => boolean {
  const gitignorePath = join(dir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    return () => false;
  }
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
        // Wildcard prefix match (e.g. *.log)
        if (clean.startsWith('*') && name.endsWith(clean.slice(1))) return true;
      }
      return false;
    };
  } catch {
    return () => false;
  }
}

// ── File tree ─────────────────────────────────────────────────────────────────

/**
 * Recursively scan a directory tree, respecting .gitignore and SKIP_DIRS.
 *
 * @param dir - Absolute path to scan.
 * @param depth - Current recursion depth.
 * @param maxDepth - Maximum depth to descend.
 * @param gitignoreFilter - Filter function from loadGitignorePatterns.
 */
export function buildFileTree(
  dir: string,
  depth = 0,
  maxDepth = MAX_TREE_DEPTH,
  gitignoreFilter?: (name: string, isDir: boolean) => boolean,
): FileTreeNode {
  const filter = gitignoreFilter ?? loadGitignorePatterns(dir);
  const name = basename(dir);

  if (depth === 0) {
    log.verbose('Building file tree', { dir, maxDepth });
  }

  const node: FileTreeNode = {
    name,
    path: dir,
    type: 'directory',
    children: [],
  };

  if (depth >= maxDepth) {
    return node;
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return node;
  }

  for (const entry of entries) {
    if (entry.startsWith('.') && entry !== '.env.example') continue;
    const fullPath = join(dir, entry);

    let isDir = false;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }

    if (isDir && SKIP_DIRS.has(entry)) continue;
    if (filter(entry, isDir)) continue;

    if (isDir) {
      const child = buildFileTree(fullPath, depth + 1, maxDepth, filter);
      node.children!.push(child);
    } else {
      let size: number | undefined;
      try {
        size = statSync(fullPath).size;
      } catch {
        // ignore
      }
      node.children!.push({
        name: entry,
        path: fullPath,
        type: 'file',
        size,
        ext: extname(entry),
      });
    }
  }

  return node;
}

/**
 * Render a file tree node as an indented text string (like `tree` CLI output).
 *
 * @param node - Root node to render.
 * @param rootDir - Used to make paths relative in the output.
 * @param depth - Current depth (for indentation).
 */
export function renderFileTree(
  node: FileTreeNode,
  rootDir: string,
  depth = 0,
): string {
  const indent = '  '.repeat(depth);
  const label = depth === 0 ? relative(rootDir, node.path) || '.' : node.name;
  const lines: string[] = [`${indent}${label}/`];

  if (node.children) {
    for (const child of node.children) {
      if (child.type === 'directory') {
        lines.push(renderFileTree(child, rootDir, depth + 1));
      } else {
        lines.push(`${'  '.repeat(depth + 1)}${child.name}`);
      }
    }
  }
  return lines.join('\n');
}

// ── Key file reading ──────────────────────────────────────────────────────────

/**
 * Read and summarize key project files (package.json, README, config files).
 *
 * @param dir - Project root directory.
 */
export function readKeyFiles(dir: string): KeyFileSummary[] {
  const summaries: KeyFileSummary[] = [];

  const candidates: Array<{ path: string; kind: KeyFileSummary['kind'] }> = [
    { path: 'package.json', kind: 'package.json' },
    { path: 'pyproject.toml', kind: 'config' },
    { path: 'Cargo.toml', kind: 'config' },
    { path: 'go.mod', kind: 'config' },
    { path: 'pom.xml', kind: 'config' },
    { path: 'build.gradle', kind: 'config' },
    { path: 'Makefile', kind: 'config' },
    { path: 'tsconfig.json', kind: 'config' },
    { path: '.eslintrc.json', kind: 'config' },
    { path: 'eslint.config.js', kind: 'config' },
    { path: '.eslintrc.js', kind: 'config' },
    { path: 'jest.config.ts', kind: 'config' },
    { path: 'jest.config.js', kind: 'config' },
    { path: 'vitest.config.ts', kind: 'config' },
    { path: 'vite.config.ts', kind: 'config' },
    { path: 'next.config.js', kind: 'config' },
    { path: 'next.config.ts', kind: 'config' },
    { path: '.github/workflows/ci.yml', kind: 'ci' },
    { path: '.github/workflows/main.yml', kind: 'ci' },
    { path: 'README.md', kind: 'readme' },
    { path: 'README.MD', kind: 'readme' },
    { path: 'readme.md', kind: 'readme' },
  ];

  for (const candidate of candidates) {
    const fullPath = join(dir, candidate.path);
    if (!existsSync(fullPath)) continue;
    try {
      const raw = readFileSync(fullPath, 'utf-8');
      const content = raw.length > MAX_FILE_READ_BYTES
        ? raw.slice(0, MAX_FILE_READ_BYTES) + '\n... [truncated]'
        : raw;
      summaries.push({ path: candidate.path, kind: candidate.kind, content });
    } catch {
      // skip unreadable files
    }
  }

  return summaries;
}

// ── Tech stack detection ──────────────────────────────────────────────────────

/**
 * Detect the tech stack from key project files and directory structure.
 *
 * @param dir - Project root directory.
 * @param keyFiles - Pre-read key file summaries (avoids double-reading).
 */
export function identifyTechStack(dir: string, keyFiles: KeyFileSummary[]): TechStack {
  const stack: TechStack = {
    language: 'unknown',
    framework: null,
    testFramework: null,
    buildSystem: null,
    lintCommand: null,
    packageManager: null,
    dependencies: {},
    devDependencies: {},
  };

  // Parse package.json for Node.js/JS projects
  const pkgFile = keyFiles.find((f) => f.path === 'package.json');
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      const deps = pkg.dependencies ?? {};
      const devDeps = pkg.devDependencies ?? {};
      const allDeps = { ...deps, ...devDeps };
      stack.dependencies = deps;
      stack.devDependencies = devDeps;

      // Language: TypeScript vs JavaScript
      if ('typescript' in devDeps || 'typescript' in deps) {
        stack.language = 'TypeScript';
      } else {
        stack.language = 'JavaScript';
      }

      // Framework detection (order matters — more specific first)
      if ('next' in allDeps) stack.framework = 'Next.js';
      else if ('nuxt' in allDeps) stack.framework = 'Nuxt.js';
      else if ('@remix-run/node' in allDeps || '@remix-run/react' in allDeps) stack.framework = 'Remix';
      else if ('astro' in allDeps) stack.framework = 'Astro';
      else if ('svelte' in allDeps) stack.framework = 'Svelte';
      else if ('vue' in allDeps) stack.framework = 'Vue';
      else if ('react' in allDeps || 'react-dom' in allDeps) stack.framework = 'React';
      else if ('express' in allDeps) stack.framework = 'Express';
      else if ('fastify' in allDeps) stack.framework = 'Fastify';
      else if ('hono' in allDeps) stack.framework = 'Hono';
      else if ('koa' in allDeps) stack.framework = 'Koa';
      else if ('nestjs' in allDeps || '@nestjs/core' in allDeps) stack.framework = 'NestJS';

      // Test framework
      if ('vitest' in allDeps) stack.testFramework = 'vitest';
      else if ('jest' in allDeps) stack.testFramework = 'jest';
      else if ('mocha' in allDeps) stack.testFramework = 'mocha';
      else if ('jasmine' in allDeps) stack.testFramework = 'jasmine';
      else if ('@playwright/test' in allDeps) stack.testFramework = 'playwright';
      else if ('cypress' in allDeps) stack.testFramework = 'cypress';

      // Build system
      if ('vite' in allDeps) stack.buildSystem = 'vite';
      else if ('webpack' in allDeps) stack.buildSystem = 'webpack';
      else if ('esbuild' in allDeps) stack.buildSystem = 'esbuild';
      else if ('rollup' in allDeps) stack.buildSystem = 'rollup';
      else if ('parcel' in allDeps) stack.buildSystem = 'parcel';
      else if ('typescript' in allDeps || 'typescript' in devDeps) stack.buildSystem = 'tsc';
      else if ('tsup' in allDeps) stack.buildSystem = 'tsup';

      // Lint command
      if ('eslint' in allDeps) {
        const scripts = pkg.scripts ?? {};
        const lintScript = scripts['lint'] ?? scripts['lint:check'];
        stack.lintCommand = lintScript ?? 'eslint .';
      }
      if ('biome' in allDeps) stack.lintCommand = 'biome check .';

      // Package manager
      if (existsSync(join(dir, 'pnpm-lock.yaml'))) stack.packageManager = 'pnpm';
      else if (existsSync(join(dir, 'yarn.lock'))) stack.packageManager = 'yarn';
      else if (existsSync(join(dir, 'package-lock.json'))) stack.packageManager = 'npm';
      else stack.packageManager = 'npm';
    } catch {
      // malformed package.json
    }
    return stack;
  }

  // Python (pyproject.toml / setup.py)
  if (keyFiles.some((f) => f.path === 'pyproject.toml') || existsSync(join(dir, 'setup.py'))) {
    stack.language = 'Python';
    stack.packageManager = 'pip';
    if (existsSync(join(dir, 'poetry.lock'))) stack.packageManager = 'poetry';
    if (existsSync(join(dir, 'uv.lock'))) stack.packageManager = 'uv';

    const pyproject = keyFiles.find((f) => f.path === 'pyproject.toml');
    if (pyproject) {
      if (pyproject.content.includes('fastapi')) stack.framework = 'FastAPI';
      else if (pyproject.content.includes('django')) stack.framework = 'Django';
      else if (pyproject.content.includes('flask')) stack.framework = 'Flask';
      if (pyproject.content.includes('pytest')) stack.testFramework = 'pytest';
      if (pyproject.content.includes('ruff')) stack.lintCommand = 'ruff check .';
      else if (pyproject.content.includes('flake8')) stack.lintCommand = 'flake8';
    }
    if (existsSync(join(dir, 'pytest.ini')) || existsSync(join(dir, 'conftest.py'))) {
      stack.testFramework = stack.testFramework ?? 'pytest';
    }
    return stack;
  }

  // Go
  if (keyFiles.some((f) => f.path === 'go.mod')) {
    stack.language = 'Go';
    stack.buildSystem = 'go build';
    stack.testFramework = 'go test';
    stack.lintCommand = 'golangci-lint run';
    return stack;
  }

  // Rust
  if (keyFiles.some((f) => f.path === 'Cargo.toml')) {
    stack.language = 'Rust';
    stack.buildSystem = 'cargo build';
    stack.testFramework = 'cargo test';
    stack.lintCommand = 'cargo clippy';
    stack.packageManager = 'cargo';
    return stack;
  }

  // Java / Kotlin (Gradle)
  if (keyFiles.some((f) => f.path === 'build.gradle')) {
    stack.language = 'Java';
    stack.buildSystem = 'gradle build';
    stack.testFramework = 'JUnit';
    return stack;
  }

  // Java (Maven)
  if (keyFiles.some((f) => f.path === 'pom.xml')) {
    stack.language = 'Java';
    stack.buildSystem = 'mvn compile';
    stack.testFramework = 'JUnit';
    return stack;
  }

  // Fallback: detect by file extensions present
  const extCounts: Record<string, number> = {};
  try {
    const walkExt = (d: string, depth = 0): void => {
      if (depth > 3) return;
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        try {
          if (statSync(full).isDirectory()) {
            if (!SKIP_DIRS.has(entry)) walkExt(full, depth + 1);
          } else {
            const ext = extname(entry);
            if (ext) extCounts[ext] = (extCounts[ext] ?? 0) + 1;
          }
        } catch { /* skip */ }
      }
    };
    walkExt(dir);
  } catch { /* skip */ }

  const dominant = Object.entries(extCounts).sort((a, b) => b[1] - a[1])[0];
  if (dominant) {
    const langMap: Record<string, string> = {
      '.ts': 'TypeScript', '.tsx': 'TypeScript',
      '.js': 'JavaScript', '.jsx': 'JavaScript',
      '.py': 'Python', '.go': 'Go', '.rs': 'Rust',
      '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#',
      '.cpp': 'C++', '.c': 'C', '.rb': 'Ruby', '.php': 'PHP',
    };
    stack.language = langMap[dominant[0]] ?? dominant[0].slice(1).toUpperCase();
  }

  return stack;
}

// ── Entry point detection ─────────────────────────────────────────────────────

/**
 * Detect application entry points in a project directory.
 *
 * @param dir - Project root.
 * @param keyFiles - Pre-read key file summaries.
 */
export function detectEntryPoints(dir: string, keyFiles: KeyFileSummary[]): string[] {
  const entryPoints: string[] = [];

  // Node.js: check "main" in package.json
  const pkgFile = keyFiles.find((f) => f.path === 'package.json');
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content) as { main?: string; bin?: Record<string, string> | string };
      if (pkg.main) entryPoints.push(pkg.main);
      if (pkg.bin) {
        if (typeof pkg.bin === 'string') {
          entryPoints.push(pkg.bin);
        } else {
          entryPoints.push(...Object.values(pkg.bin));
        }
      }
    } catch { /* skip */ }
  }

  // Common convention-based entry points
  const conventional = [
    'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
    'src/app.ts', 'src/app.js', 'src/server.ts', 'src/server.js',
    'index.ts', 'index.js', 'main.ts', 'main.js', 'main.py',
    'app.py', 'app.ts', 'app.js', 'cmd/main.go', 'src/main.rs',
    'src/lib.rs',
  ];

  for (const ep of conventional) {
    if (existsSync(join(dir, ep)) && !entryPoints.includes(ep)) {
      entryPoints.push(ep);
    }
  }

  return entryPoints;
}

// ── Relevant file selection ───────────────────────────────────────────────────

/**
 * Walk the file tree and collect source files relevant to a coding task.
 *
 * @param dir - Project root.
 * @param treeNode - Pre-built file tree (avoids double-scanning).
 * @param maxFiles - Maximum number of files to return.
 */
export function collectRelevantFiles(
  dir: string,
  treeNode: FileTreeNode,
  maxFiles = MAX_RELEVANT_FILES,
): CodebaseScanOutput['relevantFiles'] {
  const results: CodebaseScanOutput['relevantFiles'] = [];

  const walk = (node: FileTreeNode): void => {
    if (results.length >= maxFiles) return;
    if (node.type === 'file') {
      if (!SOURCE_EXTENSIONS.has(node.ext ?? '')) return;
      try {
        const content = readFileSync(node.path, 'utf-8');
        const lines = content.split('\n').length;

        let role: 'source' | 'test' | 'config' | 'docs' = 'source';
        const name = node.name.toLowerCase();
        if (name.includes('.test.') || name.includes('.spec.') || name.endsWith('_test.go')) {
          role = 'test';
        } else if (
          name.includes('config') || name.includes('.env') ||
          ['.json', '.yaml', '.yml', '.toml', '.ini'].includes(node.ext ?? '')
        ) {
          role = 'config';
        }

        let complexity: 'low' | 'medium' | 'high' = 'low';
        if (lines > 500) complexity = 'high';
        else if (lines > 100) complexity = 'medium';

        results.push({
          path: relative(dir, node.path),
          role,
          complexity,
          linesOfCode: lines,
        });
      } catch { /* skip unreadable */ }
    } else if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };

  walk(treeNode);
  return results;
}

// ── LOC estimation ───────────────────────────────────────────────────────────

function estimateTotalLoc(relevantFiles: CodebaseScanOutput['relevantFiles']): number {
  return relevantFiles.reduce((sum, f) => sum + f.linesOfCode, 0);
}

// ── Main analysis function ────────────────────────────────────────────────────

/**
 * Perform a full codebase analysis and return a structured ArchitectureSummary.
 *
 * This is the main entry point for the codebase-scanner node.
 *
 * @param dir - Absolute path to the project root.
 */
export async function analyzeCodebase(dir: string): Promise<ArchitectureSummary> {
  log.info('Starting codebase analysis', { dir });

  const keyFiles = readKeyFiles(dir);
  const techStack = identifyTechStack(dir, keyFiles);
  const treeNode = buildFileTree(dir);
  const projectStructure = renderFileTree(treeNode, dir);
  const entryPoints = detectEntryPoints(dir, keyFiles);
  const relevantFiles = collectRelevantFiles(dir, treeNode);
  const estimatedLoc = estimateTotalLoc(relevantFiles);

  // Count total files by walking tree
  let totalFiles = 0;
  const countFiles = (node: FileTreeNode): void => {
    if (node.type === 'file') { totalFiles++; return; }
    node.children?.forEach(countFiles);
  };
  countFiles(treeNode);

  log.info('Codebase analysis complete', {
    language: techStack.language,
    framework: techStack.framework,
    totalFiles,
    relevantFiles: relevantFiles.length,
    estimatedLoc,
  });

  return {
    techStack,
    projectStructure,
    keyFiles,
    entryPoints,
    relevantFiles,
    totalFiles,
    estimatedLoc,
  };
}

/**
 * Convert an ArchitectureSummary to the CodebaseScanOutput format
 * expected by the CodingPlanner and workflow templates.
 *
 * @param summary - The full architecture summary.
 */
export function toCodebaseScanOutput(summary: ArchitectureSummary): CodebaseScanOutput {
  return {
    language: summary.techStack.language,
    framework: summary.techStack.framework,
    testFramework: summary.techStack.testFramework,
    buildSystem: summary.techStack.buildSystem,
    lintCommand: summary.techStack.lintCommand,
    projectStructure: summary.projectStructure,
    relevantFiles: summary.relevantFiles,
    entryPoints: summary.entryPoints,
    dependencies: summary.techStack.dependencies,
  };
}

/**
 * Quick scan that produces a CodebaseScanOutput directly.
 * Combines analyzeCodebase + toCodebaseScanOutput.
 *
 * @param dir - Absolute path to the project root.
 */
export async function scanCodebase(dir: string): Promise<CodebaseScanOutput> {
  const summary = await analyzeCodebase(dir);
  return toCodebaseScanOutput(summary);
}
