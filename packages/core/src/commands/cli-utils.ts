import * as readline from 'node:readline';

export const GREEN = '\x1b[32m';
export const RED = '\x1b[31m';
export const YELLOW = '\x1b[33m';
export const BLUE = '\x1b[34m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const RESET = '\x1b[0m';

export function print(msg: string): void { process.stdout.write(msg); }
export function println(msg: string = ''): void { process.stdout.write(msg + '\n'); }
export function success(msg: string): void { println(`${GREEN}✓${RESET} ${msg}`); }
export function fail(msg: string): void { println(`${RED}✗${RESET} ${msg}`); }
export function warn(msg: string): void { println(`${YELLOW}⚠${RESET} ${msg}`); }
export function heading(msg: string): void { println(`\n${BOLD}${BLUE}${msg}${RESET}\n`); }

export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length < 12) return '***';
  return value.slice(0, 7) + '***' + value.slice(-4);
}

let rl: readline.Interface;

export function getRL(): readline.Interface {
  return rl;
}

export function initRL(): void {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on('close', () => {
    println(`\n${YELLOW}Setup cancelled.${RESET}`);
    process.exit(0);
  });
}

export function closeRL(): void {
  rl.removeAllListeners('close');
  rl.close();
}

export function ask(question: string, opts?: { default?: string }): Promise<string> {
  return new Promise((resolve) => {
    const suffix = opts?.default ? ` ${DIM}(${opts.default})${RESET}` : '';
    const prompt = `${question}${suffix}: `;
    rl.question(prompt, (answer: string) => {
      resolve(answer.trim() || opts?.default || '');
    });
  });
}

export function choose(question: string, options: { label: string; value: string }[]): Promise<string> {
  return new Promise((resolve) => {
    println(question);
    for (let i = 0; i < options.length; i++) {
      println(`  ${BOLD}${i + 1}${RESET}) ${options[i].label}`);
    }

    const promptForChoice = (): void => {
      rl.question(`\nChoice [1-${options.length}]: `, (answer: string) => {
        const idx = parseInt(answer.trim(), 10) - 1;
        if (idx >= 0 && idx < options.length) {
          resolve(options[idx].value);
        } else {
          warn(`Please enter a number between 1 and ${options.length}.`);
          promptForChoice();
        }
      });
    };
    promptForChoice();
  });
}

export function confirm(question: string, defaultYes: boolean = true): Promise<boolean> {
  return new Promise((resolve) => {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    rl.question(`${question} [${hint}]: `, (answer: string) => {
      const a = answer.trim().toLowerCase();
      resolve(a === '' ? defaultYes : a === 'y' || a === 'yes');
    });
  });
}

export function askSecret(message: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(message);
    let value = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener('data', onData);
          origWrite('\n');
          resolve(value);
          return;
        } else if (ch === '\u0003') {
          process.stdin.setRawMode?.(false);
          process.exit(1);
        } else if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            origWrite('\b \b');
          }
        } else {
          value += ch;
          origWrite('•');
        }
      }
    };
    process.stdin.on('data', onData);
  });
}
