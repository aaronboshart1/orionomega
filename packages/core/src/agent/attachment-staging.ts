/**
 * @module agent/attachment-staging
 *
 * Task #192: Stage chat attachments to disk so every DAG worker can reach
 * them via absolute paths.
 *
 * Why this exists:
 * - Pre-#192 the wire-protocol attachments (CSV, PDF, images, …) were
 *   embedded inline as base64 / text blocks in the user turn. AGENT,
 *   CODING_AGENT, and TOOL workers in a planned DAG could not actually
 *   read those bytes — there was no on-disk file for them to open.
 * - This module writes each attachment to `<sessionDir>/_attachments/<name>`
 *   and returns absolute paths the planner preamble + per-worker context
 *   can quote verbatim. Workers Read/cat/etc the file directly.
 *
 * Idempotency contract (retry reuses without overwrite):
 *   - If `<sessionDir>/_attachments/<name>` already exists and its bytes
 *     are byte-identical to the incoming attachment, the write is SKIPPED
 *     and the existing file is reused. This is what makes a turn-level
 *     retry (same convOutputId, same attachment) cheap — the second pass
 *     never touches disk for the payload, only for the directory mkdir.
 *   - If the existing file's bytes DIFFER, we throw
 *     `AttachmentStagingError` rather than silently clobber. Two distinct
 *     uploads sharing a filename within the same session is ambiguous —
 *     the caller (web UI) is responsible for picking a unique name (or
 *     prompting the user) before re-staging.
 *
 * Failure contract (write failure aborts):
 *   - Any I/O error (mkdir, write, stat) throws an `AttachmentStagingError`
 *     carrying the offending file name and the underlying error message.
 *   - Callers (`MainAgent.handleMessage`) surface the verbatim message to
 *     the user via `callbacks.onText` and abort the dispatch — we do NOT
 *     silently drop the attachment.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';

/** A single attachment that has been written to the per-session staging dir. */
export interface StagedAttachment {
  /** Sanitised file name (basename only — no directories). */
  name: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Declared MIME type from the wire protocol. */
  mimeType: string;
  /** Byte size of the on-disk file. */
  size: number;
}

/** Wire-protocol attachment shape forwarded from the websocket layer. */
export interface IncomingAttachment {
  name: string;
  size: number;
  type: string;
  /** Bare base64 OR `data:<mime>;base64,<…>` DataURL. */
  data?: string;
  /** Inline UTF-8 text content (for text/code attachments). */
  textContent?: string;
}

export interface StageAttachmentsInput {
  /** Attachments forwarded from the websocket layer. */
  attachments: IncomingAttachment[];
  /**
   * The per-session run directory. Staging always writes to
   * `<sessionDir>/_attachments/<sanitised-name>`. Caller supplies an
   * absolute path; we mkdir-recursive on this dir and the `_attachments`
   * subdir so it works on first turn and on every subsequent turn.
   */
  sessionDir: string;
}

/** Thrown when staging cannot complete. The caller surfaces the message verbatim. */
export class AttachmentStagingError extends Error {
  constructor(
    public readonly attachmentName: string,
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentStagingError';
  }
}

/** Reserved subdirectory name. Must NOT collide with any planner-emitted node id. */
export const ATTACHMENTS_DIR_NAME = '_attachments';

/**
 * Strip a `data:<mime>;base64,` prefix from a DataURL payload, returning
 * just the raw base64. Returns null when the input is empty.
 */
function stripBase64Prefix(raw: string): string | null {
  const m = /^data:[^;,]+;base64,(.+)$/i.exec(raw);
  if (m) return m[1] ?? null;
  return raw.length > 0 ? raw : null;
}

/**
 * Sanitise an incoming filename to a safe basename. Defends against
 * `../`, absolute paths, and accidental directory components.
 */
function sanitiseName(name: string): string {
  const base = basename(name).replace(/[\x00-\x1f]/g, '').trim();
  if (!base || base === '.' || base === '..') {
    return `attachment-${Date.now().toString(36)}`;
  }
  return base;
}

/**
 * Decode an incoming attachment to its raw bytes. Throws
 * `AttachmentStagingError` when the payload is unusable so the caller
 * can surface a clear "file dropped" message instead of writing a corrupt
 * stub.
 */
function decodeAttachmentBytes(att: IncomingAttachment): Buffer {
  if (att.textContent !== undefined) {
    return Buffer.from(att.textContent, 'utf-8');
  }
  if (!att.data) {
    throw new AttachmentStagingError(
      att.name,
      `Attachment "${att.name}" (${att.type}) has no inline content (no data and no textContent).`,
    );
  }
  const b64 = stripBase64Prefix(att.data);
  if (!b64) {
    throw new AttachmentStagingError(
      att.name,
      `Attachment "${att.name}" carries unreadable base64 data.`,
    );
  }
  try {
    return Buffer.from(b64, 'base64');
  } catch (err) {
    throw new AttachmentStagingError(
      att.name,
      `Attachment "${att.name}" base64 decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Stage every attachment to `<sessionDir>/_attachments/<name>` and return
 * the on-disk descriptors. Idempotent — see module docstring.
 */
export function stageAttachments(input: StageAttachmentsInput): StagedAttachment[] {
  const { attachments, sessionDir } = input;
  if (!attachments || attachments.length === 0) return [];

  const stagingDir = resolvePath(sessionDir, ATTACHMENTS_DIR_NAME);
  try {
    mkdirSync(stagingDir, { recursive: true });
  } catch (err) {
    throw new AttachmentStagingError(
      '<staging-dir>',
      `Failed to create attachment staging directory ${stagingDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const out: StagedAttachment[] = [];
  for (const att of attachments) {
    const name = sanitiseName(att.name);
    const absPath = resolvePath(stagingDir, name);
    const bytes = decodeAttachmentBytes(att);

    let needsWrite = true;
    if (existsSync(absPath)) {
      let existing: Buffer | null = null;
      try {
        existing = readFileSync(absPath);
      } catch (err) {
        throw new AttachmentStagingError(
          name,
          `Failed to read existing staged file at ${absPath} for byte-compare: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (existing.length === bytes.length && existing.equals(bytes)) {
        needsWrite = false;
      } else {
        // Different bytes for the same filename within the same session
        // is ambiguous — fail loudly rather than clobber.
        throw new AttachmentStagingError(
          name,
          `Attachment "${name}" already exists at ${absPath} with different bytes (existing=${existing.length}B, incoming=${bytes.length}B). Refusing to overwrite — use a unique filename.`,
        );
      }
    }

    if (needsWrite) {
      try {
        writeFileSync(absPath, bytes);
      } catch (err) {
        throw new AttachmentStagingError(
          name,
          `Failed to write attachment "${name}" to ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let size = bytes.length;
    try {
      size = statSync(absPath).size;
    } catch {
      // Stat failure is non-fatal — fall back to the buffer length.
    }

    out.push({
      name,
      absPath,
      mimeType: att.type || 'application/octet-stream',
      size,
    });
  }

  return out;
}

/**
 * Render the human-readable preamble block listing every staged file.
 * Embedded into the planner's task prompt and into per-worker context
 * (AGENT injectedContext, CODING_AGENT task) so every worker type can
 * see and Read the files via absolute paths.
 *
 * Returns an empty string when there are no staged attachments so callers
 * can prepend it unconditionally.
 */
export function renderStagedAttachmentsBlock(staged: StagedAttachment[]): string {
  if (!staged || staged.length === 0) return '';
  const lines = staged
    .map((s) => `- ${s.absPath}  (mime: ${s.mimeType}, size: ${s.size} bytes, name: ${s.name})`)
    .join('\n');
  return `## Attached files (staged on disk — read via absolute paths)
The user uploaded the following file(s). They are already written to disk
at the absolute paths below. Any AGENT / CODING_AGENT / TOOL worker can
open them directly (Read tool, \`cat\`, language-native file APIs). Do
NOT ask the user to re-upload and do NOT attempt to fetch over the
network — the bytes are local.

${lines}`;
}
