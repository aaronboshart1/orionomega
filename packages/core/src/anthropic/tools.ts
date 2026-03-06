/**
 * @module anthropic/tools
 * Built-in tool definitions and executor bridge for Anthropic tool_use responses.
 *
 * These are truly universal tools available to all workers regardless of skills.
 * Web-specific tools (web_search, web_fetch) are provided as Skills SDK skills
 * in the default-skills/ directory and installed to ~/.orionomega/skills/.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** A built-in tool available to every worker agent. */
export interface BuiltInTool {
  /** Tool name (matches the Anthropic tool_use name). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** Executes the tool with the given parameters and context. */
  execute: (
    params: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<string>;
}

/** Execution context passed to tool implementations. */
export interface ToolContext {
  /** Working directory for relative paths and command execution. */
  workingDir: string;
  /** Default timeout in seconds. */
  timeout: number;
}

const MAX_OUTPUT_CHARS = 10_000;

/**
 * Truncates a string to the given max length, appending an ellipsis indicator.
 */
function truncate(text: string, max: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n... [truncated, ${text.length - max} chars omitted]`;
}

/**
 * Returns the set of built-in tools available to all worker agents.
 *
 * Tools: exec, read, write, edit.
 * Note: web_search and web_fetch are provided as Skills SDK skills.
 */
export function getBuiltInTools(): BuiltInTool[] {
  return [
    {
      name: 'exec',
      description:
        'Run a shell command and return its stdout. Use for running scripts, installing packages, checking system state, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute.',
          },
          cwd: {
            type: 'string',
            description:
              'Working directory for the command. Defaults to the workspace directory.',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds. Defaults to the worker timeout.',
          },
        },
        required: ['command'],
      },
      execute: async (
        params: Record<string, unknown>,
        context: ToolContext,
      ): Promise<string> => {
        const command = String(params.command ?? '');
        const cwd = String(params.cwd ?? context.workingDir);
        const timeout = Number(params.timeout ?? context.timeout) * 1000;

        if (!command) return 'Error: command is required';

        try {
          const stdout = execSync(command, {
            cwd,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return truncate(stdout);
        } catch (err: unknown) {
          const e = err as {
            status?: number;
            stdout?: string;
            stderr?: string;
            message?: string;
          };
          const output = [
            e.stdout ? `stdout:\n${e.stdout}` : '',
            e.stderr ? `stderr:\n${e.stderr}` : '',
            `exit code: ${e.status ?? 'unknown'}`,
          ]
            .filter(Boolean)
            .join('\n');
          return truncate(
            `Command failed:\n${output || e.message || String(err)}`,
          );
        }
      },
    },

    {
      name: 'read',
      description:
        'Read the contents of a file. Supports offset and limit for large files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to read.',
          },
          offset: {
            type: 'number',
            description: 'Line number to start reading from (1-indexed).',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read.',
          },
        },
        required: ['path'],
      },
      execute: async (
        params: Record<string, unknown>,
      ): Promise<string> => {
        const filePath = String(params.path ?? '');
        if (!filePath) return 'Error: path is required';

        try {
          const content = readFileSync(filePath, 'utf-8');
          const lines = content.split('\n');

          const offset = Math.max(1, Number(params.offset ?? 1));
          const limit = params.limit ? Number(params.limit) : lines.length;

          const slice = lines.slice(offset - 1, offset - 1 + limit);
          return truncate(slice.join('\n'));
        } catch (err) {
          return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    {
      name: 'write',
      description:
        'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to write.',
          },
          content: {
            type: 'string',
            description: 'Content to write to the file.',
          },
        },
        required: ['path', 'content'],
      },
      execute: async (
        params: Record<string, unknown>,
      ): Promise<string> => {
        const filePath = String(params.path ?? '');
        const content = String(params.content ?? '');
        if (!filePath) return 'Error: path is required';

        try {
          const dir = dirname(filePath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(filePath, content, 'utf-8');
          return `Successfully wrote ${content.length} bytes to ${filePath}`;
        } catch (err) {
          return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    {
      name: 'edit',
      description:
        'Edit a file by replacing an exact string match. The old_string must match exactly (including whitespace).',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to edit.',
          },
          old_string: {
            type: 'string',
            description: 'Exact text to find and replace.',
          },
          new_string: {
            type: 'string',
            description: 'New text to replace the old text with.',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      execute: async (
        params: Record<string, unknown>,
      ): Promise<string> => {
        const filePath = String(params.path ?? '');
        const oldString = String(params.old_string ?? '');
        const newString = String(params.new_string ?? '');

        if (!filePath) return 'Error: path is required';
        if (!oldString) return 'Error: old_string is required';

        try {
          const content = readFileSync(filePath, 'utf-8');
          if (!content.includes(oldString)) {
            return `Error: old_string not found in ${filePath}. Make sure the text matches exactly (including whitespace and line endings).`;
          }

          const occurrences = content.split(oldString).length - 1;
          if (occurrences > 1) {
            return `Error: old_string found ${occurrences} times in ${filePath}. It must be unique. Add more surrounding context to make it unique.`;
          }

          const updated = content.replace(oldString, newString);
          writeFileSync(filePath, updated, 'utf-8');
          return `Successfully edited ${filePath}`;
        } catch (err) {
          return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}
