/**
 * @module settings
 * Settings resolution, validation, and schema utilities for OrionOmega skills.
 *
 * Handles the full lifecycle of skill settings:
 * 1. Extracting the UI-renderable schema from a manifest
 * 2. Shimming legacy `setup.fields` arrays to the modern `settings` block
 * 3. Merging manifest defaults with user-saved configuration
 * 4. Validating user-supplied values against the schema
 * 5. Masking secret values in log output
 *
 * No external dependencies — pure TypeScript validation to keep the package lightweight.
 */

import type {
  SkillManifest,
  SkillSettingsBlock,
  SkillSettingSchema,
  SkillSetup,
  SkillSetupField,
  ValidationResult,
} from './types.js';
import { SkillSettingGroup, SkillSettingType } from './types.js';

// ── Schema Extraction ──────────────────────────────────────────────────

export function getSettingsSchema(manifest: SkillManifest): SkillSettingsBlock | null {
  if (manifest.settings) {
    return manifest.settings;
  }

  if (manifest.setup?.fields && manifest.setup.fields.length > 0) {
    return shimFieldsToSettings(manifest.setup);
  }

  return null;
}

export function shimFieldsToSettings(setup: SkillSetup): SkillSettingsBlock {
  const properties: Record<string, SkillSettingSchema> = {};
  const required: string[] = [];

  for (const method of setup.auth?.methods ?? []) {
    if (method.envVar) {
      properties[method.envVar] = {
        type: SkillSettingType.Password,
        label: method.label,
        description: method.description,
        required: false,
        group: SkillSettingGroup.Auth,
        widget: 'secret',
      };
    }
  }

  for (const field of setup.fields ?? []) {
    properties[field.name] = shimField(field);
    if (field.required) {
      required.push(field.name);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function shimField(field: SkillSetupField): SkillSettingSchema {
  let type: SkillSettingType;
  switch (field.type) {
    case 'boolean':
      type = SkillSettingType.Boolean;
      break;
    case 'number':
      type = SkillSettingType.Number;
      break;
    case 'select':
      type = SkillSettingType.Select;
      break;
    default:
      type = field.mask ? SkillSettingType.Password : SkillSettingType.String;
  }

  const schema: SkillSettingSchema = {
    type,
    label: field.label,
    description: field.description,
    required: field.required,
    default: field.default,
    group: field.mask ? SkillSettingGroup.Auth : SkillSettingGroup.Preferences,
    widget: field.mask ? 'secret' : undefined,
    options: field.options,
  };

  return schema;
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

  const schema = getSettingsSchema(manifest);

  if (!schema) {
    return { valid: true, errors, warnings };
  }

  for (const key of schema.required ?? []) {
    const value = settings[key];
    if (value === undefined || value === null || value === '') {
      errors.push(`Required setting "${key}" is missing or empty.`);
    }
  }

  for (const [key, prop] of Object.entries(schema.properties)) {
    const value = settings[key];

    if (value === undefined || value === null) {
      continue;
    }

    const typeError = checkType(key, value, prop);
    if (typeError) {
      errors.push(typeError);
      continue;
    }

    const constraintErrors = checkConstraints(key, value, prop);
    errors.push(...constraintErrors);
  }

  for (const key of Object.keys(settings)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
      warnings.push(`Unknown setting "${key}" is not declared in the manifest schema.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function checkType(key: string, value: unknown, prop: SkillSettingSchema): string | null {
  const types = Array.isArray(prop.type) ? prop.type : [prop.type];

  for (const t of types) {
    if (matchesType(value, t)) return null;
  }

  const typeName = Array.isArray(prop.type) ? prop.type.join(' | ') : prop.type;
  return `Setting "${key}" has invalid type. Expected ${typeName}, got ${typeof value}.`;
}

function matchesType(value: unknown, type: SkillSettingType): boolean {
  switch (type) {
    case SkillSettingType.String:
    case SkillSettingType.Password:
    case SkillSettingType.URL:
    case SkillSettingType.Textarea:
      return typeof value === 'string';
    case SkillSettingType.Boolean:
      return typeof value === 'boolean';
    case SkillSettingType.Number:
      return typeof value === 'number' && Number.isFinite(value);
    case SkillSettingType.Select:
      return typeof value === 'string';
    case SkillSettingType.Multiselect:
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    default:
      return false;
  }
}

function checkConstraints(
  key: string,
  value: unknown,
  prop: SkillSettingSchema,
): string[] {
  const errors: string[] = [];
  const v = prop.validation;

  if (typeof value === 'string') {
    if (v?.min !== undefined && value.length < v.min) {
      errors.push(`Setting "${key}" must be at least ${v.min} characters long.`);
    }
    if (v?.max !== undefined && value.length > v.max) {
      errors.push(`Setting "${key}" must be at most ${v.max} characters long.`);
    }
    if (v?.pattern) {
      try {
        if (!new RegExp(v.pattern).test(value)) {
          errors.push(`Setting "${key}" does not match the required pattern.`);
        }
      } catch {
        // Silently ignore invalid patterns
      }
    }
    if (v?.enum && !v.enum.includes(value)) {
      errors.push(
        `Setting "${key}" must be one of: ${v.enum.map(String).join(', ')}.`,
      );
    }
  }

  if (typeof value === 'number') {
    if (v?.min !== undefined && value < v.min) {
      errors.push(`Setting "${key}" must be at least ${v.min}.`);
    }
    if (v?.max !== undefined && value > v.max) {
      errors.push(`Setting "${key}" must be at most ${v.max}.`);
    }
    if (v?.enum && !v.enum.includes(value)) {
      errors.push(
        `Setting "${key}" must be one of: ${v.enum.map(String).join(', ')}.`,
      );
    }
  }

  const types = Array.isArray(prop.type) ? prop.type : [prop.type];
  if (types.includes(SkillSettingType.Select) && prop.options) {
    const allowed = prop.options.map((o) => o.value);
    if (typeof value === 'string' && !allowed.includes(value)) {
      errors.push(
        `Setting "${key}" must be one of: ${allowed.join(', ')}.`,
      );
    }
  }

  if (types.includes(SkillSettingType.Multiselect) && prop.options && Array.isArray(value)) {
    const allowed = new Set(prop.options.map((o) => o.value));
    for (const item of value as string[]) {
      if (!allowed.has(item)) {
        errors.push(
          `Setting "${key}" contains invalid option "${item}". Allowed: ${[...allowed].join(', ')}.`,
        );
      }
    }
  }

  return errors;
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
