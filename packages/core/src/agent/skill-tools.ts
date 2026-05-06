/**
 * @module agent/skill-tools
 * Shared skill MCP-tool builder used by both the orchestration worker path
 * (agent-sdk-bridge.buildSkillMcpServer) and the direct-chat path
 * (conversation.streamConversation).
 *
 * Loads each requested skill via SkillLoader, drops disabled / failed-to-load
 * skills with a warning, and returns a flat list of tool entries that can be
 * advertised to the model and dispatched through SkillExecutor.
 */

import path from 'node:path';
import {
  SkillLoader,
  SkillExecutor,
  readSkillConfig,
} from '@orionomega/skills-sdk';
import { createLogger } from '../logging/logger.js';

const log = createLogger('skill-tools');

/** Separator used when namespacing a manifest tool name for direct-chat use. */
export const SKILL_TOOL_NAMESPACE_SEPARATOR = '__';

/**
 * Process-wide dedup cache for skip warnings. `respondConversationally`
 * rebuilds the skill toolset every turn, so without this cache a single
 * persistently broken or disabled skill would emit the same warn line on
 * every user message — noisy in long sessions. Each `<skillId>:<reason>`
 * pair logs at most once per process.
 */
const warnedSkips = new Set<string>();
function warnSkipOnce(skillId: string, reason: string, message: string): void {
  const key = `${skillId}:${reason}`;
  if (warnedSkips.has(key)) return;
  warnedSkips.add(key);
  log.warn(message);
}

/**
 * A single skill-provided tool, ready to advertise to a model and execute.
 *
 * `name` is the namespaced (`<skillId>__<toolName>`) identifier intended for
 * the direct-chat tool surface, where multiple skills share a single flat
 * tool list and could otherwise collide. Workers (which expose each skill
 * through its own MCP server) should prefer `rawName`.
 */
export interface SkillToolEntry {
  /** Namespaced tool name, e.g. `google-workspace__gmail`. */
  name: string;
  /** Original tool name from the manifest, e.g. `gmail`. */
  rawName: string;
  /** Skill that contributed this tool. */
  skillId: string;
  /** Tool description, surfaced to the model. */
  description: string;
  /** JSON Schema input descriptor. */
  inputSchema: Record<string, unknown>;
  /** Resolved absolute path to the handler script. */
  handlerPath: string;
  /** Skill working directory (passed to SkillExecutor). */
  cwd: string;
  /** Per-skill env vars assembled from the skill's saved config fields. */
  env: Record<string, string>;
  /** Handler execution timeout (ms). */
  timeout: number;
}

/** A skill that was requested but could not contribute tools. */
export interface SkillToolFailure {
  skillId: string;
  reason: string;
}

export interface SkillToolBuildResult {
  tools: SkillToolEntry[];
  failures: SkillToolFailure[];
}

/**
 * Either a bare skill id (manifest is in the configured skillsDir) or a
 * pair binding the skill id to the directory whose `<id>/manifest.json`
 * should be loaded — used so a skill whose manifest ships in
 * `default-skills/` can still pull its config (enabled / configured /
 * fields) from the user's configured `~/.orionomega/skills` dir.
 */
export type SkillRef = string | { id: string; manifestDir: string };

/**
 * Build a flat list of skill-tool entries for the given skill IDs.
 *
 * `skillsDir` is the user's *config* dir — used for `readSkillConfig`
 * (enabled / configured / fields) and threaded to handlers via
 * `ORIONOMEGA_SKILLS_DIR` so per-account file layouts (e.g.
 * google-workspace) resolve correctly. The manifest itself is loaded
 * from each ref's `manifestDir` when provided, otherwise from
 * `skillsDir`. This split is what lets default-skills manifests be
 * exposed to the agent even when the user only has a config directory
 * for the skill (no copy of the manifest tree).
 *
 * Skills that fail to load, are disabled, or whose handlers we can't resolve
 * are skipped with a single warn log and recorded in `failures`. A single
 * broken skill never poisons the rest of the list.
 */
export async function buildSkillToolset(
  skillRefs: SkillRef[],
  skillsDir: string,
  loader?: SkillLoader,
): Promise<SkillToolBuildResult> {
  const defaultLoader = loader ?? new SkillLoader(skillsDir);
  const loadersByDir = new Map<string, SkillLoader>();
  loadersByDir.set(path.resolve(skillsDir), defaultLoader);
  const tools: SkillToolEntry[] = [];
  const failures: SkillToolFailure[] = [];
  const seen = new Set<string>();

  for (const ref of skillRefs) {
    const skillId = typeof ref === 'string' ? ref : ref.id;
    const manifestDir = typeof ref === 'string' ? skillsDir : ref.manifestDir;
    const manifestDirAbs = path.resolve(manifestDir);
    let sl = loadersByDir.get(manifestDirAbs);
    if (!sl) {
      sl = new SkillLoader(manifestDirAbs);
      loadersByDir.set(manifestDirAbs, sl);
    }

    let loaded;
    try {
      loaded = await sl.load(skillId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnSkipOnce(skillId, 'load-failed', `buildSkillToolset: skipping "${skillId}" — failed to load: ${reason}`);
      failures.push({ skillId, reason });
      continue;
    }

    const cfg = readSkillConfig(skillsDir, skillId);
    if (!cfg.enabled) {
      warnSkipOnce(skillId, 'disabled', `buildSkillToolset: skipping "${skillId}" — disabled`);
      failures.push({ skillId, reason: 'disabled' });
      continue;
    }
    if (loaded.manifest.setup?.required && !cfg.configured) {
      warnSkipOnce(skillId, 'setup-required', `buildSkillToolset: skipping "${skillId}" — setup required but not configured`);
      failures.push({ skillId, reason: 'setup-required' });
      continue;
    }

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.fields)) env[k] = String(v);
    // Thread the resolved skills dir into every handler invocation so
    // hooks/handlers (e.g. google-workspace's per-account file layout
    // resolver) read from the SAME directory the gateway is using.
    // Without this, `_accounts.getSkillsDir()` falls back to
    // `~/.orionomega/skills` and misses the Replit-style
    // `./.orionomega/skills` location, breaking active-account
    // resolution at tool-call time.
    env.ORIONOMEGA_SKILLS_DIR = path.resolve(skillsDir);

    const skillDir = loaded.skillDir;
    for (const t of loaded.manifest.tools ?? []) {
      const nsName = `${skillId}${SKILL_TOOL_NAMESPACE_SEPARATOR}${t.name}`;
      if (seen.has(nsName)) {
        log.warn(`buildSkillToolset: dropping duplicate namespaced tool "${nsName}"`);
        continue;
      }
      seen.add(nsName);
      tools.push({
        name: nsName,
        rawName: t.name,
        skillId,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
        handlerPath: path.resolve(skillDir, t.handler),
        cwd: skillDir,
        env,
        timeout: t.timeout ?? 30_000,
      });
    }
  }

  return { tools, failures };
}

/**
 * Execute a built skill-tool entry and return a stringified result suitable
 * for feeding back to the model as a tool-result content block. Handler
 * errors are surfaced as `Error: <message>` strings rather than thrown so
 * the conversation loop's normal tool-error handling path applies.
 */
/**
 * Maximum bytes returned to the model for a single skill tool call.
 * Mirrors the 30KB cap `executeMainTool` enforces on `read_file`/`exec`
 * outputs so the conversation context does not balloon when a skill
 * returns a large payload.
 */
export const SKILL_TOOL_OUTPUT_MAX_BYTES = 30_000;

function truncateForModel(text: string): string {
  if (text.length <= SKILL_TOOL_OUTPUT_MAX_BYTES) return text;
  return text.slice(0, SKILL_TOOL_OUTPUT_MAX_BYTES) + '\n... [truncated at 30KB]';
}

export async function executeSkillToolEntry(
  entry: SkillToolEntry,
  args: Record<string, unknown>,
  executor?: SkillExecutor,
): Promise<string> {
  const exec = executor ?? new SkillExecutor();
  try {
    const result = await exec.executeHandler(entry.handlerPath, args, {
      cwd: entry.cwd,
      timeout: entry.timeout,
      env: entry.env,
    });
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return truncateForModel(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Skill tool "${entry.name}" failed: ${msg}`);
    return `Error: ${msg}`;
  }
}
