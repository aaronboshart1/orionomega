import { readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createLogger } from '../logging/index.js';

const log = createLogger('command-file-loader');

export interface FileCommand {
  name: string;
  content: string;
  filePath: string;
}

export class CommandFileLoader {
  private commands: Map<string, FileCommand> = new Map();
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    this.ensureDirectory();
    this.reload();
  }

  private ensureDirectory(): void {
    if (!existsSync(this.directory)) {
      try {
        mkdirSync(this.directory, { recursive: true });
        log.info(`Created commands directory: ${this.directory}`);
      } catch (err) {
        log.warn(`Failed to create commands directory: ${this.directory}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  reload(): void {
    this.commands.clear();

    if (!existsSync(this.directory)) {
      return;
    }

    try {
      const files = readdirSync(this.directory);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const name = basename(file, '.md').toLowerCase();
        const filePath = join(this.directory, file);
        try {
          const content = readFileSync(filePath, 'utf-8');
          this.commands.set(name, { name, content, filePath });
        } catch (err) {
          log.warn(`Failed to read command file: ${filePath}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (this.commands.size > 0) {
        log.info(`Loaded ${this.commands.size} file command(s): ${[...this.commands.keys()].join(', ')}`);
      }
    } catch (err) {
      log.warn(`Failed to scan commands directory: ${this.directory}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  lookup(commandName: string): FileCommand | undefined {
    const name = commandName.replace(/^\//, '').replace(/\.md$/, '').toLowerCase();
    return this.commands.get(name);
  }

  list(): FileCommand[] {
    return [...this.commands.values()];
  }

  listNames(): string[] {
    return [...this.commands.keys()];
  }
}
