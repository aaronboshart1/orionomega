/**
 * Task #232: REST body validation (Zod) parity tests for the Git tab routes.
 * Focuses on the new behaviour — malformed bodies are rejected with 400
 * before any store mutation happens.
 */

import { describe, it, expect } from 'vitest';
import { handleGitRoute } from '../git.js';
import { createMockPostReq, createMockRes } from './test-utils.js';
import type { IncomingMessage } from 'node:http';

function reqWithBody(url: string, method: string, body: string): IncomingMessage {
  const req = createMockPostReq(url, body);
  (req as unknown as { method: string }).method = method;
  return req;
}

const deps = { workspaceDir: '/tmp/orionomega-test-ws' };

describe('handleGitRoute body validation', () => {
  it('rejects POST /api/git/repos with a missing remoteUrl', async () => {
    const { mock, res } = createMockRes();
    const handled = await handleGitRoute(
      reqWithBody('/api/git/repos', 'POST', JSON.stringify({ label: 'x' })),
      res, '/api/git/repos', 'POST', deps,
    );
    expect(handled).toBe(true);
    expect(mock.statusCode).toBe(400);
    expect(mock.body).toContain('remoteUrl');
  });

  it('rejects POST /api/git/repos with a non-string remoteUrl', async () => {
    const { mock, res } = createMockRes();
    await handleGitRoute(
      reqWithBody('/api/git/repos', 'POST', JSON.stringify({ remoteUrl: 123 })),
      res, '/api/git/repos', 'POST', deps,
    );
    expect(mock.statusCode).toBe(400);
  });

  it('rejects POST /api/git/repos with unknown extra keys (strict schema)', async () => {
    const { mock, res } = createMockRes();
    await handleGitRoute(
      reqWithBody('/api/git/repos', 'POST', JSON.stringify({ remoteUrl: 'https://github.com/a/b.git', evil: true })),
      res, '/api/git/repos', 'POST', deps,
    );
    expect(mock.statusCode).toBe(400);
  });

  it('rejects PUT session repo selection without repoId', async () => {
    const { mock, res } = createMockRes();
    const path = '/api/git/sessions/sess1/repo';
    await handleGitRoute(
      reqWithBody(path, 'PUT', JSON.stringify({ branch: 'main' })),
      res, path, 'PUT', deps,
    );
    expect(mock.statusCode).toBe(400);
    expect(mock.body).toContain('repoId');
  });

  it('rejects PATCH repo update with wrong-typed label', async () => {
    const { mock, res } = createMockRes();
    const path = '/api/git/repos/repo1';
    await handleGitRoute(
      reqWithBody(path, 'PATCH', JSON.stringify({ label: 42 })),
      res, path, 'PATCH', deps,
    );
    expect(mock.statusCode).toBe(400);
  });
});
