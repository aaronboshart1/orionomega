/**
 * @module loader
 * Skill discovery, loading, matching, and dependency checking.
 *
 * Provides both a high-level {@link SkillLoader} class for lifecycle management
 * and standalone functions ({@link discoverSkills}, {@link loadSkillManifest},
 * {@link instantiateSkill}) for lightweight, ad-hoc usage.
 *
 * ## Dual-mode skill loading
 *
 * The loader supports two skill implementation patterns, which can coexist in
 * the same skills directory without any configuration:
 *
 * **Manifest mode (legacy / language-agnostic)**
 * Any directory with a `manifest.json` is a valid skill. Tools are executed by
 * spawning the handler scripts listed in the manifest.
 *
 * **Class mode (TypeScript-native)**
 * If a compiled `skill.js` exists alongside `manifest.json`, the loader imports
 * it and uses the exported default class (which must extend {@link BaseSkill})
 * as the {@link ISkill} implementation.
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
  SkillConfig,
  SkillContext,
} from './types.js';
import { validateManifest } from './validator.js';
import { readSkillConfig } from './skill-config.js';
import { SkillExecutor } from './executor.js';
import type { ISkill } from './interfaces.js';
import { BaseSkill } from './interfaces.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT = 30_000;

// ── Dual-mode helpers ──────────────────────────────────────────────────

async function tryLoadSkillClass(
  skillDir: string,
  logger?: { warn(msg: string, data?: Record<string, unknown>): void },
): Promise<(new () => ISkill) | null> {
  const classPath = path.join(path.resolve(skillDir), 'skill.js');

  try {
    await stat(classPath);
  } catch {
    return null;
  }

  try {
    const mod = (await import(classPath)) as { default?: new () => ISkill };
    const SkillClass = mod.default;

    if (typeof SkillClass !== 'function') {
      logger?.warn(`skill.js at "${classPath}" does not export a default class — using manifest mode`, {
        skillDir,
      });
      return null;
    }

    return SkillClass;
  } catch (err) {
    logger?.warn(`Failed to import skill.js at "${classPath}" — using manifest mode`, {
      skillDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Standalone Functions ───────────────────────────────────────────────

export async function discoverSkills(skillsDir: string): Promise<string[]> {
  const resolved = path.resolve(skillsDir);
  const results: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(resolved);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const skillDir = path.join(resolved, entry);
    try {
      const st = await stat(skillDir);
      if (!st.isDirectory()) continue;

      await stat(path.join(skillDir, 'manifest.json'));
      results.push(skillDir);
    } catch {
      // Not a skill directory
    }
  }

  return results;
}

export async function loadSkillManifest(skillPath: string): Promise<SkillManifest> {
  const manifestPath = path.join(path.resolve(skillPath), 'manifest.json');

  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot read manifest at "${manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let manifest: SkillManifest;
  try {
    manifest = JSON.parse(raw) as SkillManifest;
  } catch (err) {
    throw new Error(
      `Invalid JSON in manifest at "${manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = validateManifest(manifest);
  if (!result.valid) {
    throw new Error(
      `Manifest at "${manifestPath}" failed validation: ${result.errors.join('; ')}`,
    );
  }

  return manifest;
}

export async function instantiateSkill(
  manifest: SkillManifest,
  config: SkillConfig,
  skillDir: string,
): Promise<ISkill> {
  const resolvedDir = path.resolve(skillDir);

  const SkillClass = await tryLoadSkillClass(resolvedDir);
  if (SkillClass) {
    return new SkillClass();
  }

  const executor = new SkillExecutor();
  const toolDefs = manifest.tools ?? [];

  class ManifestSkill extends BaseSkill {
    override async initialize(ctx: SkillContext): Promise<void> {
      await super.initialize(ctx);

      const settings = manifest.settings;
      if (settings?.required) {
        for (const key of settings.required) {
          if (!Object.prototype.hasOwnProperty.call(settings.properties, key)) continue;
          if (!(key in config.fields)) {
            ctx.logger.warn(
              `Skill "${manifest.name}" requires setting "${key}" but it is not configured.`,
            );
          }
        }
      }
    }

    getTools() {
      return toolDefs.map((t) => ({ ...t }));
    }

    async executeTool(toolName: string, params: Record<string, unknown>): Promise<unknown> {
      const tool = toolDefs.find((t) => t.name === toolName);
      if (!tool) {
        throw new Error(`Tool "${toolName}" not found in skill "${manifest.name}".`);
      }
      return executor.executeHandler(tool.handler, params, {
        cwd: resolvedDir,
        timeout: tool.timeout ?? DEFAULT_TIMEOUT,
      });
    }
  }

  return new ManifestSkill();
}

// ── SkillLoader Class ──────────────────────────────────────────────────

export class SkillLoader {
  private readonly skillsDir: string;
  private readonly loaded = new Map<string, LoadedSkill>();
  private readonly discovered = new Map<string, SkillManifest>();
  private readonly instances = new Map<string, ISkill>();
  private readonly executor = new SkillExecutor();

  constructor(skillsDir: string) {
    this.skillsDir = path.resolve(skillsDir);
  }

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

        const manifest = await loadSkillManifest(skillDir);
        manifests.push(manifest);
        this.discovered.set(manifest.name, manifest);
      } catch {
        continue;
      }
    }

    return manifests;
  }

  async discoverReady(): Promise<SkillManifest[]> {
    const all = await this.discoverAll();
    return all.filter((m) => {
      const config = readSkillConfig(this.skillsDir, m.name);
      if (!config.enabled) return false;
      if (m.setup?.required && !config.configured) return false;
      return true;
    });
  }

  async load(skillName: string): Promise<LoadedSkill> {
    const skillDir = path.join(this.skillsDir, skillName);

    let manifest: SkillManifest;
    try {
      manifest = await loadSkillManifest(skillDir);
    } catch (err) {
      throw new Error(
        `Failed to load skill "${skillName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const depCheck = await this.checkDependencies(manifest);
    if (!depCheck.valid) {
      throw new Error(
        `Skill "${skillName}" has unmet dependencies: ${depCheck.errors.join('; ')}`,
      );
    }

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

    let skillDoc = '';
    try {
      skillDoc = await readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    } catch {
      // Leave empty
    }

    let workerPrompt: string | undefined;
    try {
      workerPrompt = await readFile(path.join(skillDir, 'prompts', 'worker.md'), 'utf-8');
    } catch {
      // Optional
    }

    const tools: RegisteredTool[] = (manifest.tools ?? []).map((toolDef) => ({
      name: toolDef.name,
      description: toolDef.description,
      inputSchema: toolDef.inputSchema,
      execute: async (params: Record<string, unknown>): Promise<unknown> =>
        this.executor.executeHandler(toolDef.handler, params, {
          cwd: skillDir,
          timeout: toolDef.timeout ?? DEFAULT_TIMEOUT,
        }),
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

  async loadISkill(skillName: string, ctx?: SkillContext): Promise<ISkill> {
    if (!this.loaded.has(skillName)) {
      await this.load(skillName);
    }

    const loaded = this.loaded.get(skillName)!;
    const config = readSkillConfig(this.skillsDir, skillName);

    const skill = await instantiateSkill(loaded.manifest, config, loaded.skillDir);
    this.instances.set(skillName, skill);

    if (ctx) {
      await skill.initialize(ctx);
      await skill.activate();
    }

    return skill;
  }

  getISkill(skillName: string): ISkill | undefined {
    return this.instances.get(skillName);
  }

  unload(skillName: string): void {
    this.loaded.delete(skillName);
    this.instances.delete(skillName);
  }

  get(skillName: string): LoadedSkill | undefined {
    return this.loaded.get(skillName);
  }

  getAll(): LoadedSkill[] {
    return Array.from(this.loaded.values());
  }

  matchSkills(userInput: string): SkillManifest[] {
    const matched = new Map<string, SkillManifest>();
    const input = userInput.trim();
    const inputLower = input.toLowerCase();

    const allManifests = new Map<string, SkillManifest>(this.discovered);
    for (const [name, loaded] of this.loaded) {
      allManifests.set(name, loaded.manifest);
    }

    for (const [, manifest] of allManifests) {
      for (const cmd of manifest.triggers.commands ?? []) {
        if (
          inputLower === cmd.toLowerCase() ||
          inputLower.startsWith(cmd.toLowerCase() + ' ')
        ) {
          matched.set(manifest.name, manifest);
        }
      }
    }

    for (const [, manifest] of allManifests) {
      if (matched.has(manifest.name)) continue;
      for (const kw of manifest.triggers.keywords ?? []) {
        if (inputLower.includes(kw.toLowerCase())) {
          matched.set(manifest.name, manifest);
          break;
        }
      }
    }

    for (const [, manifest] of allManifests) {
      if (matched.has(manifest.name)) continue;
      for (const pattern of manifest.triggers.patterns ?? []) {
        try {
          if (new RegExp(pattern, 'i').test(input)) {
            matched.set(manifest.name, manifest);
            break;
          }
        } catch {
          // Invalid regex — skip
        }
      }
    }

    return Array.from(matched.values());
  }

  async checkDependencies(manifest: SkillManifest): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const cmd of manifest.requires.commands ?? []) {
      try {
        await execFileAsync('which', [cmd]);
      } catch {
        errors.push(`Required command not found: "${cmd}".`);
      }
    }

    for (const envVar of manifest.requires.env ?? []) {
      if (!process.env[envVar]) {
        errors.push(`Required environment variable not set: "${envVar}".`);
      }
    }

    for (const skillName of manifest.requires.skills ?? []) {
      if (!this.loaded.has(skillName) && !this.discovered.has(skillName)) {
        errors.push(`Required skill not available: "${skillName}".`);
      }
    }

    if ((manifest.requires.ports ?? []).length > 0) {
      warnings.push(
        `Skill requires ports [${manifest.requires.ports!.join(', ')}] — not verified at load time.`,
      );
    }
    if ((manifest.requires.services ?? []).length > 0) {
      warnings.push(
        `Skill requires services [${manifest.requires.services!.join(', ')}] — not verified at load time.`,
      );
    }

    return { valid: errors.length === 0, errors, warnings };
  }
}
