/**
 * @module __tests__/persistence-message-idempotent
 * Regression tests for Task #184 — `PersistenceService.appendMessage` must be
 * idempotent for `(sessionId, id)` so duplicate streaming-completion writes do
 * not surface as `UNIQUE constraint failed: messages.id` errors. Also covers
 * the `SessionManager.addMessage` warn-suppression behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '@orionomega/core';
import { PersistenceService } from '../persistence.js';
import { SessionManager, type Message } from '../sessions.js';

let originalHome: string | undefined;

function setupDb(): string {
  const homeDir = mkdtempSync(join(tmpdir(), 'orion-msg-idem-'));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  closeDb();
  getDb();
  return homeDir;
}

function teardownDb(homeDir: string): void {
  closeDb();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('PersistenceService.appendMessage — idempotency', () => {
  let dbPath: string;
  let svc: PersistenceService;
  const sid = 'sess-idem-1';

  beforeEach(() => {
    dbPath = setupDb();
    svc = new PersistenceService();
    svc.createSession(sid);
  });

  afterEach(() => {
    teardownDb(dbPath);
  });

  it('duplicate id with identical payload is a silent no-op', () => {
    const msg = {
      id: 'm1', role: 'assistant', content: 'hello world',
      metadata: { workflowId: 'wf-1' }, status: 'text',
    };
    expect(() => svc.appendMessage(sid, msg)).not.toThrow();
    expect(() => svc.appendMessage(sid, msg)).not.toThrow();

    const rows = svc.getMessages(sid);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('m1');
    expect(rows[0].content).toBe('hello world');
  });

  it('duplicate id with longer streaming content updates the row in place (single row, seq preserved)', () => {
    svc.appendMessage(sid, { id: 'm2', role: 'assistant', content: 'hel', status: 'text' });
    const firstSeq = svc.getMessages(sid)[0].seq;

    svc.appendMessage(sid, { id: 'm2', role: 'assistant', content: 'hello world (final)', status: 'text', metadata: { done: true } });

    const rows = svc.getMessages(sid);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('hello world (final)');
    expect(rows[0].metadata).toBe(JSON.stringify({ done: true }));
    expect(rows[0].seq).toBe(firstSeq);
  });

  it('genuine write failures (closed db) still throw', () => {
    closeDb();
    expect(() => svc.appendMessage(sid, { id: 'm-fail', role: 'assistant', content: 'x' })).toThrow();
  });

  it('cross-session id collision is rejected with an explicit error', () => {
    const sid2 = 'sess-idem-2';
    svc.createSession(sid2);
    svc.appendMessage(sid, { id: 'shared-id', role: 'assistant', content: 'a' });
    expect(() => svc.appendMessage(sid2, { id: 'shared-id', role: 'assistant', content: 'a' }))
      .toThrow(/collision across sessions/);
  });
});

describe('SessionManager.addMessage — duplicate-id producer guard', () => {
  let dbPath: string;
  let mgr: SessionManager;
  let sid: string;

  beforeEach(() => {
    dbPath = setupDb();
    const svc = new PersistenceService();
    mgr = new SessionManager(svc);
    sid = mgr.createSession('test').id;
  });

  afterEach(() => {
    teardownDb(dbPath);
  });

  it('replaying the same message id twice does not log [session:sqlite:write] or UNIQUE failures', () => {
    // The gateway logger routes every level through `console.log` with a
    // `[WARN  ]` / `[ERROR ]` tag in the prefix. Spy on console.log and assert
    // neither the duplicate-write warn nor the UNIQUE-constraint error appears.
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const base: Message = {
      id: 'mreplay', role: 'assistant', content: 'partial',
      timestamp: new Date().toISOString(), type: 'text',
    };
    expect(() => mgr.addMessage(sid, base)).not.toThrow();
    expect(() => mgr.addMessage(sid, { ...base, content: 'partial complete' })).not.toThrow();

    const sessionMessages = mgr.getSession(sid)?.messages ?? [];
    const dupCount = sessionMessages.filter((m) => m.id === 'mreplay').length;
    expect(dupCount).toBe(1);
    expect(sessionMessages.find((m) => m.id === 'mreplay')?.content).toBe('partial complete');

    const allLogs = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allLogs).not.toMatch(/\[session:sqlite:write\]/);
    expect(allLogs).not.toMatch(/UNIQUE constraint failed/i);
    expect(allLogs).not.toMatch(/\[persistence:appendMessage\] Failed/);

    consoleLogSpy.mockRestore();
  });
});
