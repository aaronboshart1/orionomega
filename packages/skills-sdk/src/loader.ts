/**
 * @module loader
 * Skill discovery, loading, matching, and dependency checking.
 * Scans a skills directory, validates manifests, registers tool executors,
 * and matches user input against skill triggers.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type {
  SkillManifest,
  LoadedSkill,
  RegisteredTool,
  ValidationResult,
} from './types.js';
import { validateManifest } from './validator.js';
import { SkillExecutor } from './executor.js';

const execFileAsync = promisify(execFile);

/** Default handler timeout in milliseconds. */
const DEFAULT_TIMEOUT = 30_000;

/**
 * Discovers, loads, validates, and matches skills from a directory.
 *
 * Skills are expected to live in subdirectories of `skillsDir`, each
 * containing a `manifest.json` file.
 */
export class SkillLoader {
  /** Absolute path to the skills directory. */
  private readonly skillsDir: string;

  /** Map of loaded skills keyed by skill name. */
  private readonly loaded = new Map<string, LoadedSkill>();

  /** Cache of discovered manifests keyed by skill name. */
  private readonly discovered = new Map<string, SkillManifest>();

  /** Shared executor instance. */
  private readonly executor = new SkillExecutor();

  /**
   * Create a new SkillLoader.
   *
   * @param skillsDir - Path to the directory containing skill subdirectories.
   */
  constructor(skillsDir: string) {
    this.skillsDir = path.resolve(skillsDir);
  }

  /**
   * Discover all valid skills in the skills directory.
   *
   * Scans for subdirectories containing a `manifest.json`, validates each,
   * and returns the valid manifests. Invalid manifests are silently skipped.
   *
   * @returns Array of validated skill manifests.
   */
  async discoverAll(): Promise<SkillManifest[]> {
    const manifests: SkillManifest[] = [];

    let entries: string[];
    try {
      entries = await readdir(this.skillsDir);
    } catch {
      return manifests;
    }

    for (const entry of entries) {
      const skillDir = path.join(this.skillsDir, entry);

      try {
        const st = await stat(skillDir);
        if (!st.isDirectory()) continue;

        const manifestPath = path.join(skillDir, 'manifest.json');
        const raw = await readFile(manifestPath, 'utf-8');
        const manifest: SkillManifest = JSON.parse(raw);
        const result = validateManifest(manifest);

        if (result.valid) {
          manifests.push(manifest);
          this.discovered.set(manifest.name, manifest);
        }
      } catch {
        // Skip directories without valid manifest.json
        continue;
      }
    }

    return manifests;
  }

  /**
   * Load a specific skill by name.
   *
   * Reads the manifest, validates it, checks dependencies, runs the preLoad
   * hook if defined, reads SKILL.md and optional worker prompt, and registers
   * tool executors.
   *
   * @param skillName - The name (slug) of the skill to load.
   * @returns The fully loaded skill.
   * @throws If the skill directory or manifest is missing, validation fails,
   *         or the preLoad hook exits non-zero.
   */
  async load(skillName: string): Promise<LoadedSkill> {
    const skillDir = path.join(this.skillsDir, skillName);

    // Read and parse manifest
    const manifestPath = path.join(skillDir, 'manifest.json');
    let manifest: SkillManifest;
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Failed to read manifest for skill "${skillName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Validate
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new Error(
        `Skill "${skillName}" manifest validation failed: ${validation.errors.join('; ')}`,
      );
    }

    // Check dependencies
    const depCheck = await this.checkDependencies(manifest);
    if (!depCheck.valid) {
      throw new Error(
        `Skill "${skillName}" has unmet dependencies: ${depCheck.errors.join('; ')}`,
      );
    }

    // Run preLoad hook if defined
    if (manifest.hooks?.preLoad) {
      const hookPath = path.resolve(skillDir, manifest.hooks.preLoad);
      try {
        await execFileAsync(hookPath, [], { cwd: skillDir, timeout: DEFAULT_TIMEOUT });
      } catch (err) {
        throw new Error(
          `Skill "${skillName}" preLoad hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Read SKILL.md
    let skillDoc = '';
    try {
      skillDoc = await readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    } catch {
      // SKILL.md is optional but expected; leave empty
    }

    // Read prompts/worker.md if present
    let workerPrompt: string | undefined;
    try {
      workerPrompt = await readFile(path.join(skillDir, 'prompts', 'worker.md'), 'utf-8');
    } catch {
      // Optional
    }

    // Register tool executors
    const tools: RegisteredTool[] = (manifest.tools ?? []).map((toolDef) => ({
      name: toolDef.name,
      description: toolDef.description,
      inputSchema: toolDef.inputSchema,
      execute: async (params: Record<string, unknown>): Promise<unknown> => {
        return this.executor.executeHandler(toolDef.handler, params, {
          cwd: skillDir,
          timeout: toolDef.timeout ?? DEFAULT_TIMEOUT,
        });
      },
    }));

    const loaded: LoadedSkill = {
      manifest,
      skillDoc,
      workerPrompt,
      tools,
      skillDir,
    };

    this.loaded.set(skillName, loaded);
    this.discovered.set(skillName, manifest);

    return loaded;
  }

  /**
   * Unload a previously loaded skill, freeing its resources.
   *
   * @param skillName - The name of the skill to unload.
   */
  unload(skillName: string): void {
    this.loaded.delete(skillName);
  }

  /**
   * Get a loaded skill by name.
   *
   * @param skillName - The skill name to look up.
   * @returns The loaded skill, or undefined if not loaded.
   */
  get(skillName: string): LoadedSkill | undefined {
    return this.loaded.get(skillName);
  }

  /**
   * Get all currently loaded skills.
   *
   * @returns Array of all loaded skills.
   */
  getAll(): LoadedSkill[] {
    return Array.from(this.loaded.values());
  }

  /**
   * Match user input against skill triggers.
   *
   * Checks slash commands first (exact prefix match), then keywords
   * (case-insensitive substring), then regex patterns. Returns all
   * matching manifests from the discovered set.
   *
   * @param userInput - The raw user input string to match.
   * @returns Array of matching skill manifests, ordered by match type
   *          (commands first, then keywords, then patterns).
   */
  matchSkills(userInput: string): SkillManifest[] {
    const matched = new Map<string, SkillManifest>();
    const input = userInput.trim();
    const inputLower = input.toLowerCase();

    // Collect manifests from both discovered and loaded
    const allManifests = new Map<string, SkillManifest>(this.discovered);
    for (const [name, loaded] of this.loaded) {
      allManifests.set(name, loaded.manifest);
    }

    // 1. Slash commands — exact prefix match
    for (const [, manifest] of allManifests) {
      if (manifest.triggers.commands) {
        for (const cmd of manifest.triggers.commands) {
          if (
            inputLower === cmd.toLowerCase() ||
            inputLower.startsWith(cmd.toLowerCase() + ' ')
          ) {
            matched.set(manifest.name, manifest);
          }
        }
      }
    }

    // 2. Keywords — case-insensitive substring
    for (const [, manifest] of allManifests) {
      if (matched.has(manifest.name)) continue;
      if (manifest.triggers.keywords) {
        for (const kw of manifest.triggers.keywords) {
          if (inputLower.includes(kw.toLowerCase())) {
            matched.set(manifest.name, manifest);
            break;
          }
        }
      }
    }

    // 3. Regex patterns
    for (const [, manifest] of allManifests) {
      if (matched.has(manifest.name)) continue;
      if (manifest.triggers.patterns) {
        for (const pattern of manifest.triggers.patterns) {
          try {
            const re = new RegExp(pattern, 'i');
            if (re.test(input)) {
              matched.set(manifest.name, manifest);
              break;
            }
          } catch {
            // Invalid regex — skip silently
          }
        }
      }
    }

    return Array.from(matched.values());
  }

  /**
   * Check if a skill's external dependencies are met.
   *
   * Verifies required CLI commands exist on PATH, required environment
   * variables are set, and required skills are loaded.
   *
   * @param manifest - The skill manifest to check dependencies for.
   * @returns Validation result with any unmet dependency errors.
   */
  async checkDependencies(manifest: SkillManifest): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check required commands
    if (manifest.requires.commands) {
      for (const cmd of manifest.requires.commands) {
        try {
          await execFileAsync('which', [cmd]);
        } catch {
          errors.push(`Required command not found: "${cmd}".`);
        }
      }
    }

    // Check required environment variables
    if (manifest.requires.env) {
      for (const envVar of manifest.requires.env) {
        if (!process.env[envVar]) {
          errors.push(`Required environment variable not set: "${envVar}".`);
        }
      }
    }

    // Check required skills are loaded
    if (manifest.requires.skills) {
      for (const skillName of manifest.requires.skills) {
        if (!this.loaded.has(skillName) && !this.discovered.has(skillName)) {
          errors.push(`Required skill not available: "${skillName}".`);
        }
      }
    }

    // Ports and services are advisory warnings (can't reliably check portably)
    if (manifest.requires.ports && manifest.requires.ports.length > 0) {
      warnings.push(
        `Skill requires ports [${manifest.requires.ports.join(', ')}] — not verified at load time.`,
      );
    }
    if (manifest.requires.services && manifest.requires.services.length > 0) {
      warnings.push(
        `Skill requires services [${manifest.requires.services.join(', ')}] — not verified at load time.`,
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
