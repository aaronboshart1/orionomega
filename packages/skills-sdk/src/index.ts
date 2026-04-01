/**
 * @module @orionomega/skills-sdk
 * Skills system for OrionOmega — create, install, load, validate, configure, and execute custom agent skills.
 *
 * @example
 * ```typescript
 * import {
 *   SkillLoader,
 *   SkillExecutor,
 *   discoverSkills,
 *   loadSkillManifest,
 *   instantiateSkill,
 *   validateManifest,
 *   resolveSettings,
 *   validateSettings,
 *   getSettingsSchema,
 *   maskSecrets,
 *   scaffoldSkill,
 * } from '@orionomega/skills-sdk';
 *
 * // High-level: discover and load all skills
 * const loader = new SkillLoader('/path/to/skills');
 * const manifests = await loader.discoverAll();
 * const skill = await loader.load('github');
 *
 * // Low-level: discover directories, load a single manifest
 * const dirs = await discoverSkills('/path/to/skills');
 * const manifest = await loadSkillManifest(dirs[0]);
 *
 * // Create an ISkill instance from a manifest (async — prefers skill.js class over manifest mode)
 * const config = readSkillConfig('/path/to/skills', 'github');
 * const instance = await instantiateSkill(manifest, config, dirs[0]);
 * await instance.initialize(ctx);
 *
 * // Settings
 * const schema = getSettingsSchema(manifest);
 * const resolved = resolveSettings(manifest, config.fields);
 * const { valid, errors } = validateSettings(manifest, resolved);
 * const safe = maskSecrets(resolved, manifest);
 * ```
 */

// ── Loader ─────────────────────────────────────────────────────────────

export {
  SkillLoader,
  discoverSkills,
  loadSkillManifest,
  instantiateSkill,
} from './loader.js';

// ── Executor ───────────────────────────────────────────────────────────

export { SkillExecutor } from './executor.js';

// ── Validator ──────────────────────────────────────────────────────────

export { validateManifest } from './validator.js';

// ── Settings ───────────────────────────────────────────────────────────

export {
  getSettingsSchema,
  resolveSettings,
  validateSettings,
  maskSecrets,
  splitSecrets,
} from './settings.js';

// ── Interfaces ─────────────────────────────────────────────────────────

export type { ISkill, SkillDefinition } from './interfaces.js';
export { BaseSkill, defineSkill } from './interfaces.js';

// ── Skill Config ───────────────────────────────────────────────────────

export {
  readSkillConfig,
  writeSkillConfig,
  isSkillReady,
  listSkillConfigs,
} from './skill-config.js';

// ── Scaffold ───────────────────────────────────────────────────────────

export { scaffoldSkill } from './scaffold.js';

// ── Types ──────────────────────────────────────────────────────────────

export type {
  // Manifest
  SkillManifest,
  SkillTool,
  // Settings schema
  SkillSettingsBlock,
  SkillSettingSchema,
  // Health & context
  HealthStatus,
  HealthErrorCode,
  SkillLogger,
  SkillContext,
  // Loaded skill
  LoadedSkill,
  RegisteredTool,
  // Validation
  ValidationResult,
  SkillInstallResult,
  // Setup & config
  SkillSetup,
  SkillSetupField,
  SkillAuthMethod,
  SkillConfig,
} from './types.js';

export {
  // Enums (values, not just types)
  SkillSettingGroup,
  SkillSettingType,
} from './types.js';
