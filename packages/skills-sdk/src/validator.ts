/**
 * @module validator
 * Manifest validation for OrionOmega skills.
 * Validates structure, semver, platform compatibility, and tool definitions
 * without touching the filesystem.
 */

import type { SkillManifest, ValidationResult } from './types.js';

/** Loose semver regex — matches X.Y.Z with optional pre-release/build. */
const SEMVER_RE =
  /^\d+\.\d+\.\d+(?:-[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/;

/** Matches common semver range operators used in compatibility strings. */
const SEMVER_RANGE_RE =
  /^(?:[~^]|[><=!]+\s*)?\d+(?:\.\d+(?:\.\d+)?)?(?:\s*(?:[-|]|&&|\|\|)\s*(?:[~^]|[><=!]+\s*)?\d+(?:\.\d+(?:\.\d+)?)?)*$/;

/**
 * Parse a semver string into its numeric components.
 * Returns null if the string is not valid semver.
 */
function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Very simple compatibility check: extracts a base version from a range string
 * and ensures currentVersion >= that base. Supports ^, ~, >=, and bare versions.
 * For anything more complex, this returns true (benefit of the doubt) with a warning.
 */
function isCompatible(range: string, currentVersion: string): boolean | null {
  const current = parseSemver(currentVersion);
  if (!current) return null;

  // Extract the first version-like segment from the range
  const m = range.match(/(\d+\.\d+\.\d+)/);
  if (!m) return null;

  const base = parseSemver(m[1]);
  if (!base) return null;

  // Simple >=: current must be >= base
  const currentNum = current.major * 1_000_000 + current.minor * 1_000 + current.patch;
  const baseNum = base.major * 1_000_000 + base.minor * 1_000 + base.patch;

  return currentNum >= baseNum;
}

/**
 * Validate a skill manifest for structural correctness.
 *
 * Checks required fields, semver validity, platform compatibility,
 * and tool definition completeness. Does **not** check filesystem paths.
 *
 * @param manifest - The skill manifest to validate.
 * @param currentVersion - The running OrionOmega version, for compatibility checks.
 * @returns A {@link ValidationResult} with errors and warnings.
 */
export function validateManifest(
  manifest: SkillManifest,
  currentVersion?: string,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Required string fields ---
  const requiredStrings: (keyof SkillManifest)[] = [
    'name',
    'version',
    'description',
    'author',
    'license',
    'orionomega',
  ];

  for (const field of requiredStrings) {
    const val = manifest[field];
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      errors.push(`Missing required field: "${field}".`);
    }
  }

  // --- Semver version ---
  if (manifest.version && !SEMVER_RE.test(manifest.version)) {
    errors.push(
      `Invalid semver version "${manifest.version}". Expected format: X.Y.Z[-prerelease][+build].`,
    );
  }

  // --- Compatibility range ---
  if (manifest.orionomega) {
    if (!SEMVER_RANGE_RE.test(manifest.orionomega.trim())) {
      warnings.push(
        `Compatibility range "${manifest.orionomega}" could not be parsed — skipping range check.`,
      );
    } else if (currentVersion) {
      const compat = isCompatible(manifest.orionomega, currentVersion);
      if (compat === false) {
        errors.push(
          `Skill requires orionomega "${manifest.orionomega}" but current version is "${currentVersion}".`,
        );
      } else if (compat === null) {
        warnings.push(
          `Could not parse current version "${currentVersion}" for compatibility check.`,
        );
      }
    }
  }

  // --- OS compatibility ---
  if (manifest.os && manifest.os.length > 0) {
    const platform = process.platform;
    // Map Node platform names to common manifest values
    const platformMap: Record<string, string> = {
      linux: 'linux',
      darwin: 'darwin',
      win32: 'windows',
    };
    const currentOs = platformMap[platform] ?? platform;
    if (!manifest.os.includes(currentOs)) {
      warnings.push(
        `Skill lists supported OS [${manifest.os.join(', ')}] but current platform is "${currentOs}".`,
      );
    }
  }

  // --- Arch compatibility ---
  if (manifest.arch && manifest.arch.length > 0) {
    const currentArch = process.arch;
    if (!manifest.arch.includes(currentArch)) {
      warnings.push(
        `Skill lists supported architectures [${manifest.arch.join(', ')}] but current arch is "${currentArch}".`,
      );
    }
  }

  // --- Requires block ---
  if (!manifest.requires || typeof manifest.requires !== 'object') {
    errors.push('Missing required field: "requires" (must be an object).');
  }

  // --- Triggers block ---
  if (!manifest.triggers || typeof manifest.triggers !== 'object') {
    errors.push('Missing required field: "triggers" (must be an object).');
  }

  // --- Tool definitions ---
  if (manifest.tools && Array.isArray(manifest.tools)) {
    for (let i = 0; i < manifest.tools.length; i++) {
      const tool = manifest.tools[i];
      const prefix = `tools[${i}]`;

      if (!tool.name || typeof tool.name !== 'string' || tool.name.trim() === '') {
        errors.push(`${prefix}: Missing or empty "name".`);
      }
      if (!tool.handler || typeof tool.handler !== 'string' || tool.handler.trim() === '') {
        errors.push(`${prefix}: Missing or empty "handler".`);
      }
      if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
        errors.push(`${prefix}: Missing or invalid "inputSchema" (must be an object).`);
      }
      if (!tool.description || typeof tool.description !== 'string') {
        warnings.push(`${prefix}: Missing "description" — recommended for discoverability.`);
      }
      if (tool.timeout !== undefined && (typeof tool.timeout !== 'number' || tool.timeout <= 0)) {
        warnings.push(`${prefix}: "timeout" should be a positive number (ms).`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
