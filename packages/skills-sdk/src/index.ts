/**
 * @module @orionomega/skills-sdk
 * Skills system for OrionOmega — create, install, load, validate, and execute custom agent skills.
 *
 * @example
 * ```typescript
 * import { SkillLoader, SkillExecutor, validateManifest, scaffoldSkill } from '@orionomega/skills-sdk';
 *
 * // Discover and load skills
 * const loader = new SkillLoader('/path/to/skills');
 * const manifests = await loader.discoverAll();
 * const skill = await loader.load('my-skill');
 *
 * // Match user input to skills
 * const matches = loader.matchSkills('/gh list issues');
 *
 * // Scaffold a new skill
 * await scaffoldSkill('my-new-skill', '/path/to/skills');
 * ```
 */

export { SkillLoader } from './loader.js';
export { SkillExecutor } from './executor.js';
export { validateManifest } from './validator.js';
export { scaffoldSkill } from './scaffold.js';
export type * from './types.js';
