/**
 * @module settings
 * Settings resolution, validation, and schema utilities for OrionOmega skills.
 *
 * Handles the full lifecycle of skill settings:
 * 1. Extracting the UI-renderable schema from a manifest
 * 2. Merging manifest defaults with user-saved configuration
 * 3. Validating user-supplied values against the schema
 * 4. Masking secret values in log output
 *
 * No external dependencies — pure TypeScript validation to keep the package lightweight.
 */

import type {
  SkillManifest,
  SkillSettingsBlock,
  SkillSettingSchema,
  ValidationResult,
} from './types.js';
import { SkillSettingType } from './types.js';
import type { JsonSchema, JsonSchemaType } from './json-schema.js';
import { validateAgainstSchema } from './json-schema.js';

// ── Schema Extraction ──────────────────────────────────────────────────

export function getSettingsSchema(manifest: SkillManifest): SkillSettingsBlock | null {
  return manifest.settings ?? null;
}

// ── Settings Resolution ────────────────────────────────────────────────

export function resolveSettings(
  manifest: SkillManifest,
  userConfig: Record<string, unknown>,
): Record<string, unknown> {
  const schema = getSettingsSchema(manifest);
  const resolved: Record<string, unknown> = {};

  if (schema) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop.default !== undefined) {
        resolved[key] = prop.default;
      }
    }
  }

  for (const [key, value] of Object.entries(userConfig)) {
    resolved[key] = value;
  }

  return resolved;
}

// ── Settings Validation ────────────────────────────────────────────────

export function validateSettings(
  manifest: SkillManifest,
  settings: Record<string, unknown>,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const block = getSettingsSchema(manifest);

  if (!block) {
    return { valid: true, errors, warnings };
  }

  // Build a proper JSON Schema from the manifest settings block and validate
  // the supplied values against it. This gives type-, range-, and enum-aware
  // checking with precise, path-qualified error messages — rather than just a
  // shallow `required` list.
  const schema = buildSettingsJsonSchema(block);
  for (const err of validateAgainstSchema(settings, schema, 'settings')) {
    errors.push(err.message);
  }

  // Unknown keys remain advisory warnings (not hard errors) for forward
  // compatibility with newer skill versions.
  for (const key of Object.keys(settings)) {
    if (!Object.prototype.hasOwnProperty.call(block.properties, key)) {
      warnings.push(`Unknown setting "${key}" is not declared in the manifest schema.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── JSON Schema generation ─────────────────────────────────────────────

const SETTING_TYPE_TO_JSON: Record<SkillSettingType, JsonSchemaType> = {
  [SkillSettingType.String]: 'string',
  [SkillSettingType.Password]: 'string',
  [SkillSettingType.URL]: 'string',
  [SkillSettingType.Textarea]: 'string',
  [SkillSettingType.Select]: 'string',
  [SkillSettingType.Number]: 'number',
  [SkillSettingType.Boolean]: 'boolean',
  [SkillSettingType.Multiselect]: 'array',
};

/**
 * Translate a manifest {@link SkillSettingsBlock} into a JSON Schema (draft-07
 * subset) suitable for {@link validateAgainstSchema}. Exposed so callers can
 * surface the canonical schema (e.g. for editor tooling) without re-deriving it.
 */
export function buildSettingsJsonSchema(block: SkillSettingsBlock): JsonSchema {
  const properties: Record<string, JsonSchema> = {};

  for (const [key, prop] of Object.entries(block.properties)) {
    properties[key] = buildPropertySchema(prop);
  }

  return {
    type: 'object',
    properties,
    required: block.required,
    // Unknown keys are handled as warnings by validateSettings, so we do not
    // forbid additional properties at the schema level.
    additionalProperties: true,
  };
}

function buildPropertySchema(prop: SkillSettingSchema): JsonSchema {
  const declared = Array.isArray(prop.type) ? prop.type : [prop.type];
  const jsonTypes = unique(declared.map((t) => SETTING_TYPE_TO_JSON[t]));
  const primary = jsonTypes[0];

  const schema: JsonSchema = {
    type: jsonTypes.length === 1 ? jsonTypes[0] : jsonTypes,
    title: prop.label,
  };

  const v = prop.validation;
  if (v) {
    if (primary === 'string') {
      if (v.min !== undefined) schema.minLength = v.min;
      if (v.max !== undefined) schema.maxLength = v.max;
      if (v.pattern !== undefined) schema.pattern = v.pattern;
    } else if (primary === 'number') {
      if (v.min !== undefined) schema.minimum = v.min;
      if (v.max !== undefined) schema.maximum = v.max;
    }
    if (v.enum && v.enum.length > 0) {
      schema.enum = [...v.enum];
    }
  }

  // URL fields get format validation unless the author overrode the pattern.
  if (declared.includes(SkillSettingType.URL) && schema.pattern === undefined) {
    schema.format = 'uri';
  }

  // Closed option lists become enums on the value (Select) or the items
  // (Multiselect), taking precedence over any author-supplied validation.enum.
  if (prop.options && prop.options.length > 0) {
    const allowed = prop.options.map((o) => o.value);
    if (declared.includes(SkillSettingType.Multiselect)) {
      schema.items = { type: 'string', enum: allowed };
    } else {
      schema.enum = allowed;
    }
  } else if (declared.includes(SkillSettingType.Multiselect)) {
    schema.items = { type: 'string' };
  }

  return schema;
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// ── Secret Masking ─────────────────────────────────────────────────────

const MASK_VALUE = '[REDACTED]';

export function maskSecrets(
  settings: Record<string, unknown>,
  manifest: SkillManifest,
): Record<string, unknown> {
  const schema = getSettingsSchema(manifest);
  if (!schema) {
    return { ...settings };
  }

  const masked = { ...settings };

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (isSecret(prop) && key in masked) {
      masked[key] = MASK_VALUE;
    }
  }

  return masked;
}

function isSecret(prop: SkillSettingSchema): boolean {
  const types = Array.isArray(prop.type) ? prop.type : [prop.type];
  return types.includes(SkillSettingType.Password) || prop.widget === 'secret';
}

export function splitSecrets(
  settings: Record<string, unknown>,
  manifest: SkillManifest,
): {
  config: Record<string, string | number | boolean>;
  secrets: Record<string, string>;
} {
  const schema = getSettingsSchema(manifest);
  const config: Record<string, string | number | boolean> = {};
  const secrets: Record<string, string> = {};

  for (const [key, value] of Object.entries(settings)) {
    const prop = schema?.properties[key];
    const secret = prop ? isSecret(prop) : false;

    if (secret) {
      secrets[key] = String(value ?? '');
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      config[key] = value;
    }
  }

  return { config, secrets };
}
