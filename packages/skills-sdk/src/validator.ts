/**
 * @module validator
 * Validates skill manifests against the SkillManifest schema.
 *
 * The validator performs structural and semantic checks without requiring
 * a full JSON Schema library, keeping the package lightweight. It reports
 * all errors in a single pass so authors can fix multiple issues at once.
 */

import type { SkillManifest, ValidationResult } from './types.js';

export function validateManifest(manifest: SkillManifest): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Required identity fields ──────────────────────────────────────────

  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push('manifest.name is required and must be a string');
  } else {
    if (!/^[a-z][a-z0-9-]*$/.test(manifest.name)) {
      warnings.push(
        `manifest.name "${manifest.name}" should be lowercase kebab-case (e.g. "my-skill")`,
      );
    }
  }

  if (!manifest.version || typeof manifest.version !== 'string') {
    errors.push(
      'manifest.version is required (semver string, e.g. "1.0.0")',
    );
  }

  if (!manifest.description || typeof manifest.description !== 'string') {
    errors.push('manifest.description is required');
  }

  if (!manifest.author || typeof manifest.author !== 'string') {
    errors.push('manifest.author is required');
  }

  if (!manifest.license || typeof manifest.license !== 'string') {
    errors.push(
      'manifest.license is required (SPDX identifier, e.g. "MIT")',
    );
  }

  // ── Compatibility ─────────────────────────────────────────────────────

  if (!manifest.orionomega || typeof manifest.orionomega !== 'string') {
    errors.push(
      'manifest.orionomega is required (version range, e.g. ">=0.1.0")',
    );
  }

  // ── Dependencies ─────────────────────────────────────────────────────

  if (!manifest.requires || typeof manifest.requires !== 'object' || Array.isArray(manifest.requires)) {
    errors.push(
      'manifest.requires is required (use {} for no requirements)',
    );
  } else {
    for (const field of ['commands', 'skills', 'env', 'ports', 'services'] as const) {
      const val = manifest.requires[field];
      if (val !== undefined && !Array.isArray(val)) {
        errors.push(`manifest.requires.${field} must be an array`);
      }
    }
  }

  // ── Triggers ──────────────────────────────────────────────────────────

  if (!manifest.triggers || typeof manifest.triggers !== 'object' || Array.isArray(manifest.triggers)) {
    errors.push('manifest.triggers is required');
  } else {
    const { keywords, patterns, commands } = manifest.triggers;
    if (keywords !== undefined && !Array.isArray(keywords)) {
      errors.push('manifest.triggers.keywords must be an array');
    }
    if (patterns !== undefined && !Array.isArray(patterns)) {
      errors.push('manifest.triggers.patterns must be an array');
    }
    if (commands !== undefined && !Array.isArray(commands)) {
      errors.push('manifest.triggers.commands must be an array');
    }

    const hasAnyTrigger =
      (keywords?.length ?? 0) > 0 ||
      (patterns?.length ?? 0) > 0 ||
      (commands?.length ?? 0) > 0;

    if (!hasAnyTrigger) {
      warnings.push(
        'manifest.triggers has no keywords, patterns, or commands — the skill will never match user input automatically',
      );
    }

    for (const pattern of patterns ?? []) {
      try {
        new RegExp(pattern);
      } catch {
        errors.push(
          `manifest.triggers.patterns contains an invalid regex: "${pattern}"`,
        );
      }
    }
  }

  // ── Tools ─────────────────────────────────────────────────────────────

  if (manifest.tools !== undefined) {
    if (!Array.isArray(manifest.tools)) {
      errors.push('manifest.tools must be an array');
    } else {
      for (const [i, tool] of manifest.tools.entries()) {
        if (!tool.name || typeof tool.name !== 'string') {
          errors.push(`manifest.tools[${i}].name is required`);
        } else if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
          warnings.push(
            `tools[${i}].name "${tool.name}" should be snake_case (e.g. "my_tool")`,
          );
        }

        if (!tool.description || typeof tool.description !== 'string') {
          errors.push(`manifest.tools[${i}].description is required`);
        }

        if (!tool.handler || typeof tool.handler !== 'string') {
          errors.push(`manifest.tools[${i}].handler is required`);
        }

        if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
          errors.push(
            `manifest.tools[${i}].inputSchema is required and must be an object`,
          );
        } else if ((tool.inputSchema as Record<string, unknown>).type !== 'object') {
          errors.push(
            `manifest.tools[${i}].inputSchema must have type "object" at the top level`,
          );
        }

        if (tool.timeout !== undefined && typeof tool.timeout !== 'number') {
          errors.push(
            `manifest.tools[${i}].timeout must be a number (milliseconds)`,
          );
        }
      }
    }
  }

  // ── Settings block (optional) ─────────────────────────────────────────

  if (manifest.settings !== undefined) {
    if (manifest.settings.type !== 'object') {
      errors.push('manifest.settings.type must be "object"');
    }
    if (
      !manifest.settings.properties ||
      typeof manifest.settings.properties !== 'object'
    ) {
      errors.push('manifest.settings.properties is required and must be an object');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
