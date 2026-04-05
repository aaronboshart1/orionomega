/**
 * @module agent/prompt-builder
 * Builds the system prompt for the main agent by combining workspace files
 * (SOUL.md, USER.md, TOOLS.md) with core orchestration instructions.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { execSync } from 'node:child_process';
import { createLogger } from '../logging/logger.js';
import { getPortAvoidanceInstructions } from '../utils/port-restrictions.js';

const log = createLogger('prompt-builder');

/** Context needed to assemble the system prompt. */
export interface PromptContext {
  /** Path to the workspace directory containing SOUL.md, USER.md, etc. */
  workspaceDir: string;
  /** Names of skills available to the orchestrator. */
  availableSkills?: string[];
  /** Whether a workflow is currently running. */
  activeWorkflow?: boolean;
}

const CORE_INSTRUCTIONS = `You are OrionOmega's main agent. Your role:

1. CONVERSATION: You talk to the user naturally. You have personality (defined in SOUL.md).
2. DELEGATION: You NEVER do work yourself. ALL tasks go to the orchestration engine.
3. PLANNING: When the user asks you to do something, you create an execution plan and present it for approval.
4. UPDATES: While orchestration runs, you relay progress updates to the user conversationally.
5. COMMANDS: You support slash commands: /stop, /status, /restart, /reset, /plan, /workers, /pause, /resume

When the user gives you a task:
- Analyse what they need
- Generate a plan (this happens automatically via the orchestration engine)
- Present the plan with: worker count, estimated cost, estimated time, brief summary of each worker's role
- Wait for the user to approve, modify, or reject

You plan FIRST, execute SECOND. Never auto-execute unless the user explicitly says "run it", "do it", "execute", "go ahead", or "build it".`;

/**
 * Safely reads a text file, returning `undefined` if missing or unreadable.
 */
async function safeRead(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Builds the full system prompt for the main agent.
 *
 * Reads workspace personality and user files, then combines them with
 * the core orchestration instructions.
 *
 * @param context - Prompt assembly context.
 * @returns The assembled system prompt string.
 */
export async function buildSystemPrompt(context: PromptContext): Promise<string> {
  const [soul, user, tools] = await Promise.all([
    safeRead(join(context.workspaceDir, 'SOUL.md')),
    safeRead(join(context.workspaceDir, 'USER.md')),
    safeRead(join(context.workspaceDir, 'TOOLS.md')),
  ]);

  const sections: string[] = [CORE_INSTRUCTIONS];

  if (soul) {
    sections.push(`\n## Personality & Voice\n${soul}`);
  }

  if (user) {
    sections.push(`\n## About the User\n${user}`);
  }

  if (tools) {
    sections.push(`\n## Tools & Environment\n${tools}`);
  }

  if (context.availableSkills && context.availableSkills.length > 0) {
    sections.push(
      `\n## Available Skills\n${context.availableSkills.map((s) => `- ${s}`).join('\n')}`,
    );
  }

  if (context.activeWorkflow) {
    sections.push(
      '\n## Active Workflow\nA workflow is currently running. Relay progress updates conversationally. The user can use /status, /stop, /pause, /resume.',
    );
  }

  // Inject runtime host identity — always authoritative over Hindsight memories
  const hostInfo = getHostIdentity();
  if (hostInfo) {
    sections.push(`\n## This Host (runtime — authoritative)\n${hostInfo}`);
  }

  sections.push(`\n${getPortAvoidanceInstructions()}`);

  return sections.join('\n');
}

/**
 * Discover the current host's identity at runtime.
 * This is authoritative — overrides any stale Hindsight memories about "this machine."
 */
function getHostIdentity(): string | null {
  try {
    const host = hostname();
    const lines: string[] = [`Hostname: ${host}`];

    // LAN IPs
    try {
      const ipOutput = execSync(
        "ip -4 addr show 2>/dev/null | grep 'inet ' | grep -v '127.0.0' | grep -v 'docker' | grep -v '172.17' | awk '{print $2}'",
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();
      if (ipOutput) {
        const ips = ipOutput.split('\n').map(ip => ip.replace(/\/\d+$/, ''));
        lines.push(`LAN IP: ${ips.join(', ')}`);
      }
    } catch {}

    // Tailscale IP
    try {
      const tsIp = execSync('tailscale ip -4 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
      if (tsIp) lines.push(`Tailscale IP: ${tsIp}`);
    } catch {}

    // OS
    try {
      const os = execSync(
        "cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME=' | cut -d= -f2 | tr -d '\"'",
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();
      if (os) lines.push(`OS: ${os}`);
    } catch {}

    // Current user
    try {
      const user = execSync('whoami', { encoding: 'utf-8', timeout: 1000 }).trim();
      lines.push(`User: ${user}`);
    } catch {}

    log.verbose('Host identity resolved', { lines });
    return lines.join('\n');
  } catch (err) {
    log.warn('Failed to resolve host identity', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
