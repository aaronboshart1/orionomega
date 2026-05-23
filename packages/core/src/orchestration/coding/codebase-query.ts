/**
 * @module orchestration/coding/codebase-query
 * Structural query interface over a built CodebaseIndex (Section 6.2).
 *
 * Provides symbol look-up, dependency traversal, BFS shortest path,
 * and impact analysis without any LLM calls or network I/O.
 */

import { join, relative } from 'node:path';
import type { CodebaseIndex, FileRecord, SymbolInfo } from './codebase-indexer.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A specific location (file + line) where a symbol is found. */
export interface SymbolLocation {
  /** Path relative to workspace root. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** Symbol name. */
  name: string;
  /** Symbol kind. */
  kind: SymbolInfo['kind'];
  /** Whether this is an exported symbol. */
  exported: boolean;
}

/** Result from a natural-language search (placeholder for semantic layer). */
export interface SearchResult {
  /** Relative file path. */
  path: string;
  /** Relevance score 0–1. */
  score: number;
  /** Excerpt from the matching code. */
  snippet: string;
}

/** Impact analysis result: which files would be affected by changes to a set of files. */
export interface ImpactResult {
  /** The seed files that were analysed. */
  changedFiles: string[];
  /**
   * All files that directly or transitively import the changed files.
   * Ordered by impact distance (direct importers first).
   */
  affectedFiles: string[];
  /** Distance from the nearest changed file (direct = 1, transitive = 2+). */
  distanceMap: Map<string, number>;
  /** Total number of affected files. */
  totalAffected: number;
}

// ── CodebaseQuery ─────────────────────────────────────────────────────────────

/**
 * Query interface over a built CodebaseIndex.
 *
 * All methods are synchronous and O(n) or O(n + e) in the worst case
 * where n = files, e = dependency edges.
 */
export class CodebaseQuery {
  private readonly index: CodebaseIndex;

  constructor(index: CodebaseIndex) {
    this.index = index;
  }

  // ── Symbol queries ──────────────────────────────────────────────────────────

  /**
   * Find all definition sites for a symbol by name.
   * Returns all files that define a symbol with the given name.
   */
  findDefinition(symbol: string): SymbolLocation[] {
    const results: SymbolLocation[] = [];
    for (const [, record] of this.index.files) {
      for (const sym of record.symbols) {
        if (sym.name === symbol) {
          results.push({
            path: record.path,
            line: sym.line,
            name: sym.name,
            kind: sym.kind,
            exported: sym.exported,
          });
        }
      }
    }
    return results;
  }

  /**
   * Find all files that reference (import) a given symbol by name.
   * A "reference" is counted when the symbol name appears in an import list.
   */
  findReferences(symbol: string): SymbolLocation[] {
    const results: SymbolLocation[] = [];
    for (const [, record] of this.index.files) {
      for (const imp of record.imports) {
        if (imp.symbols.includes(symbol)) {
          results.push({
            path: record.path,
            line: imp.line,
            name: symbol,
            kind: 'function',
            exported: false,
          });
        }
      }
    }
    return results;
  }

  /**
   * Find all files that import a function with the given name.
   * This is a subset of findReferences focused specifically on callsites.
   */
  findCallers(functionName: string): SymbolLocation[] {
    // First find where the function is defined
    const definitions = this.findDefinition(functionName).filter(
      (d) => d.kind === 'function' || d.kind === 'method',
    );
    if (definitions.length === 0) return [];

    // Then find all files that import from those definition files
    const defPaths = new Set(definitions.map((d) => d.path));
    const results: SymbolLocation[] = [];

    for (const [, record] of this.index.files) {
      for (const imp of record.imports) {
        // Import is from a file that defines the function
        const impRelPath = imp.resolved
          ? relative(this.index.workspaceDir, imp.resolved)
          : null;
        if (impRelPath && defPaths.has(impRelPath)) {
          if (imp.symbols.includes(functionName) || imp.symbols.includes('*')) {
            results.push({
              path: record.path,
              line: imp.line,
              name: functionName,
              kind: 'function',
              exported: false,
            });
          }
        }
      }
    }
    return results;
  }

  /**
   * Find all files that directly import the given file.
   * @param filePath - Path relative to workspace root.
   */
  findDependents(filePath: string): string[] {
    const absPath = join(this.index.workspaceDir, filePath);
    const incomingSet = this.index.depGraph.reverseEdges.get(absPath);
    if (!incomingSet) return [];
    return Array.from(incomingSet).map((abs) => relative(this.index.workspaceDir, abs));
  }

  // ── Graph queries ───────────────────────────────────────────────────────────

  /**
   * Find the shortest dependency path between two files using BFS.
   * Returns an array of relative paths from fromFile to toFile, or [] if no path exists.
   *
   * The path follows the import direction: fromFile imports … imports toFile.
   */
  shortestPath(fromFile: string, toFile: string): string[] {
    const absFrom = join(this.index.workspaceDir, fromFile);
    const absTo = join(this.index.workspaceDir, toFile);

    if (absFrom === absTo) return [fromFile];
    if (!this.index.depGraph.edges.has(absFrom)) return [];

    // BFS
    const queue: Array<{ node: string; path: string[] }> = [
      { node: absFrom, path: [absFrom] },
    ];
    const visited = new Set<string>([absFrom]);

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;
      const neighbours = this.index.depGraph.edges.get(node) ?? new Set();
      for (const neighbour of neighbours) {
        if (neighbour === absTo) {
          return [...path, absTo].map((p) => relative(this.index.workspaceDir, p));
        }
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          queue.push({ node: neighbour, path: [...path, neighbour] });
        }
      }
    }
    return [];
  }

  /**
   * Compute the shortest import distance from any of the target files to the given file.
   * Returns Infinity if no path exists.
   */
  shortestDistance(filePath: string, targetFiles: string[]): number {
    let minDist = Infinity;
    for (const target of targetFiles) {
      const path = this.shortestPath(filePath, target);
      if (path.length > 0) {
        minDist = Math.min(minDist, path.length - 1);
      }
      // Also check reverse direction (target imports filePath)
      const revPath = this.shortestPath(target, filePath);
      if (revPath.length > 0) {
        minDist = Math.min(minDist, revPath.length - 1);
      }
    }
    return minDist;
  }

  /**
   * Analyse the blast radius of changes to a set of files.
   * Returns all files that transitively import any of the changed files.
   *
   * @param files - Relative paths of files being changed.
   */
  impactAnalysis(files: string[]): ImpactResult {
    const seedAbsPaths = files.map((f) => join(this.index.workspaceDir, f));
    const distanceMap = new Map<string, number>();
    const queue: Array<{ path: string; distance: number }> = [];

    for (const absPath of seedAbsPaths) {
      if (this.index.depGraph.reverseEdges.has(absPath)) {
        queue.push({ path: absPath, distance: 0 });
        distanceMap.set(absPath, 0);
      }
    }

    // BFS through reverse edges (who imports this file?)
    const visited = new Set(seedAbsPaths);

    while (queue.length > 0) {
      const { path: current, distance } = queue.shift()!;
      const importers = this.index.depGraph.reverseEdges.get(current) ?? new Set();
      for (const importer of importers) {
        if (!visited.has(importer)) {
          visited.add(importer);
          const d = distance + 1;
          distanceMap.set(importer, d);
          queue.push({ path: importer, distance: d });
        }
      }
    }

    // Convert to relative paths, exclude the seed files themselves
    const seedSet = new Set(seedAbsPaths);
    const affectedFiles: string[] = [];
    const relDistanceMap = new Map<string, number>();

    for (const [absPath, dist] of distanceMap.entries()) {
      if (dist > 0 || !seedSet.has(absPath)) {
        const relPath = relative(this.index.workspaceDir, absPath);
        if (!files.includes(relPath)) {
          affectedFiles.push(relPath);
          relDistanceMap.set(relPath, dist);
        }
      }
    }

    // Sort by distance then path
    affectedFiles.sort((a, b) => {
      const da = relDistanceMap.get(a) ?? 999;
      const db = relDistanceMap.get(b) ?? 999;
      return da !== db ? da - db : a.localeCompare(b);
    });

    return {
      changedFiles: files,
      affectedFiles,
      distanceMap: relDistanceMap,
      totalAffected: affectedFiles.length,
    };
  }

  // ── Summary helpers ─────────────────────────────────────────────────────────

  /**
   * Return the top N files by PageRank score (most central files first).
   */
  topFilesByPageRank(n = 10): Array<{ path: string; pageRank: number }> {
    return Array.from(this.index.files.values())
      .map((r) => ({ path: r.path, pageRank: r.pageRank }))
      .sort((a, b) => b.pageRank - a.pageRank)
      .slice(0, n);
  }

  /**
   * List all exported symbols across the entire codebase.
   */
  allExportedSymbols(): SymbolLocation[] {
    const results: SymbolLocation[] = [];
    for (const [, record] of this.index.files) {
      for (const sym of record.symbols) {
        if (sym.exported) {
          results.push({
            path: record.path,
            line: sym.line,
            name: sym.name,
            kind: sym.kind,
            exported: true,
          });
        }
      }
    }
    return results;
  }

  /**
   * Get a file record by relative path (or null if not indexed).
   */
  getFile(relPath: string): FileRecord | null {
    return this.index.files.get(relPath) ?? null;
  }

  /**
   * Find all files that define symbols matching a prefix (case-insensitive).
   */
  searchSymbolsByPrefix(prefix: string): SymbolLocation[] {
    const lower = prefix.toLowerCase();
    const results: SymbolLocation[] = [];
    for (const [, record] of this.index.files) {
      for (const sym of record.symbols) {
        if (sym.name.toLowerCase().startsWith(lower)) {
          results.push({
            path: record.path,
            line: sym.line,
            name: sym.name,
            kind: sym.kind,
            exported: sym.exported,
          });
        }
      }
    }
    return results;
  }
}
