/**
 * @module agent/__tests__/attachment-staging
 *
 * Task #192 — unit tests for `stageAttachments` /
 * `renderStagedAttachmentsBlock`.
 *
 * Covers:
 *   - Writes each attachment to `<sessionDir>/_attachments/<name>` with the
 *     decoded bytes (DataURL prefix stripped, bare base64 accepted, UTF-8
 *     `textContent` honoured).
 *   - Idempotent retry: a second call with byte-identical payloads does
 *     NOT touch disk (mtime preserved). Differing bytes overwrite.
 *   - Sanitises `../` / absolute-path file names down to a basename.
 *   - Surfaces I/O write failure as a typed `AttachmentStagingError`.
 *   - `renderStagedAttachmentsBlock` produces a non-empty block listing
 *     each path/MIME/size, and an empty string for the empty list.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  stageAttachments,
  renderStagedAttachmentsBlock,
  AttachmentStagingError,
  ATTACHMENTS_DIR_NAME,
} from '../attachment-staging.js';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let sessionDir: string;
beforeEach(() => {
  sessionDir = mkdtempSync(path.join(tmpdir(), 'oo-stage-'));
});
afterEach(() => {
  try { chmodSync(path.join(sessionDir, ATTACHMENTS_DIR_NAME), 0o755); } catch { /* may not exist */ }
  rmSync(sessionDir, { recursive: true, force: true });
});

describe('stageAttachments (Task #192)', () => {
  it('writes a DataURL image to <sessionDir>/_attachments/<name> with decoded bytes', () => {
    const staged = stageAttachments({
      attachments: [{ name: 'pic.png', size: 70, type: 'image/png', data: `data:image/png;base64,${TINY_PNG_B64}` }],
      sessionDir,
    });
    expect(staged).toHaveLength(1);
    const expectedPath = path.join(sessionDir, ATTACHMENTS_DIR_NAME, 'pic.png');
    expect(staged[0]!.absPath).toBe(expectedPath);
    expect(staged[0]!.mimeType).toBe('image/png');
    expect(staged[0]!.size).toBeGreaterThan(0);
    expect(existsSync(expectedPath)).toBe(true);
    const onDisk = readFileSync(expectedPath);
    expect(onDisk.equals(Buffer.from(TINY_PNG_B64, 'base64'))).toBe(true);
  });

  it('accepts bare base64 (no DataURL prefix)', () => {
    const staged = stageAttachments({
      attachments: [{ name: 'a.png', size: 50, type: 'image/png', data: TINY_PNG_B64 }],
      sessionDir,
    });
    const onDisk = readFileSync(staged[0]!.absPath);
    expect(onDisk.equals(Buffer.from(TINY_PNG_B64, 'base64'))).toBe(true);
  });

  it('writes UTF-8 textContent attachments verbatim', () => {
    const staged = stageAttachments({
      attachments: [{ name: 'snippet.ts', size: 13, type: 'text/x-typescript', textContent: 'const x = 1;\n' }],
      sessionDir,
    });
    expect(readFileSync(staged[0]!.absPath, 'utf-8')).toBe('const x = 1;\n');
  });

  it('is idempotent on retry — byte-identical re-stage skips disk write (mtime preserved)', async () => {
    const att = { name: 'pic.png', size: 70, type: 'image/png', data: TINY_PNG_B64 };
    const first = stageAttachments({ attachments: [att], sessionDir });
    const mtime1 = statSync(first[0]!.absPath).mtimeMs;
    // Sleep long enough for a measurable mtime delta if a write occurred.
    await new Promise((r) => setTimeout(r, 25));
    const second = stageAttachments({ attachments: [att], sessionDir });
    const mtime2 = statSync(second[0]!.absPath).mtimeMs;
    expect(second[0]!.absPath).toBe(first[0]!.absPath);
    expect(mtime2).toBe(mtime1);
  });

  it('throws AttachmentStagingError when the existing file bytes differ from the incoming payload (no silent overwrite)', () => {
    stageAttachments({
      attachments: [{ name: 'doc.txt', size: 5, type: 'text/plain', textContent: 'hello' }],
      sessionDir,
    });
    expect(() => stageAttachments({
      attachments: [{ name: 'doc.txt', size: 5, type: 'text/plain', textContent: 'world' }],
      sessionDir,
    })).toThrow(/already exists.*different bytes/i);
    // Original bytes preserved (no clobber).
    expect(readFileSync(path.join(sessionDir, ATTACHMENTS_DIR_NAME, 'doc.txt'), 'utf-8')).toBe('hello');
  });

  it('sanitises path-traversal file names down to a basename', () => {
    const staged = stageAttachments({
      attachments: [{ name: '../../etc/passwd', size: 5, type: 'text/plain', textContent: 'safe' }],
      sessionDir,
    });
    expect(path.basename(staged[0]!.absPath)).toBe('passwd');
    expect(staged[0]!.absPath.startsWith(path.join(sessionDir, ATTACHMENTS_DIR_NAME))).toBe(true);
  });

  it('throws AttachmentStagingError when the staging dir is unwritable', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      // chmod-based read-only enforcement is unreliable for root / on Windows.
      return;
    }
    const stagingDir = path.join(sessionDir, ATTACHMENTS_DIR_NAME);
    mkdirSync(stagingDir, { recursive: true });
    chmodSync(stagingDir, 0o500); // read+exec, no write
    try {
      expect(() => stageAttachments({
        attachments: [{ name: 'x.txt', size: 5, type: 'text/plain', textContent: 'hello' }],
        sessionDir,
      })).toThrow(AttachmentStagingError);
    } finally {
      chmodSync(stagingDir, 0o755);
    }
  });

  it('throws AttachmentStagingError when an attachment carries no bytes at all', () => {
    expect(() => stageAttachments({
      attachments: [{ name: 'pic.png', size: 100, type: 'image/png' }],
      sessionDir,
    })).toThrow(/no inline content/);
  });

  it('returns [] for an empty attachments array (no staging dir created)', () => {
    expect(stageAttachments({ attachments: [], sessionDir })).toEqual([]);
    expect(existsSync(path.join(sessionDir, ATTACHMENTS_DIR_NAME))).toBe(false);
  });
});

describe('renderStagedAttachmentsBlock (Task #192)', () => {
  it('returns "" for the empty list', () => {
    expect(renderStagedAttachmentsBlock([])).toBe('');
  });

  it('lists each path / mime / size', () => {
    const block = renderStagedAttachmentsBlock([
      { name: 'a.csv', absPath: '/tmp/x/a.csv', mimeType: 'text/csv', size: 42 },
      { name: 'b.png', absPath: '/tmp/x/b.png', mimeType: 'image/png', size: 100 },
    ]);
    expect(block).toContain('/tmp/x/a.csv');
    expect(block).toContain('mime: text/csv');
    expect(block).toContain('size: 42 bytes');
    expect(block).toContain('/tmp/x/b.png');
    expect(block).toContain('Attached files (staged on disk');
  });
});
