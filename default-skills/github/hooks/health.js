#!/usr/bin/env node
/**
 * Health check: verifies gh CLI is installed, authenticated, and can reach GitHub.
 */
import { execFileSync } from 'node:child_process';

function check(label, fn) {
  try {
    const result = fn();
    return { label, ok: true, detail: result };
  } catch (err) {
    return { label, ok: false, detail: err.message ?? String(err) };
  }
}

const checks = [
  check('gh installed', () => {
    const version = execFileSync('gh', ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];
    return version;
  }),
  check('gh authenticated', () => {
    const status = execFileSync('gh', ['auth', 'status'], { encoding: 'utf-8', timeout: 10000 }).trim();
    const match = status.match(/Logged in to (\S+) account (\S+)/);
    return match ? `${match[2]}@${match[1]}` : 'authenticated';
  }),
  check('git installed', () => {
    return execFileSync('git', ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
  }),
  check('API reachable', () => {
    const result = execFileSync('gh', ['api', '/rate_limit', '--jq', '.rate.remaining'], {
      encoding: 'utf-8', timeout: 10000,
    }).trim();
    return `${result} requests remaining`;
  }),
];

const allOk = checks.every(c => c.ok);
const result = {
  healthy: allOk,
  checks,
};

process.stdout.write(JSON.stringify(result, null, 2));
process.exit(allOk ? 0 : 1);
