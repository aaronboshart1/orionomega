/**
 * @module utils/content
 * Helpers for working with conversation message content that may be either
 * a plain string or an array of Anthropic content blocks (text / image /
 * document / tool_use / tool_result / thinking).
 *
 * The hot window, history persistence, retention pipeline, and bounded
 * transcript builders all need to render multimodal content as a textual
 * approximation — base64 image / document payloads are too large and
 * not useful as "memory text". This module is the single source of truth
 * for that flattening so the conversion stays consistent everywhere.
 */

import type { ContentBlock } from '../anthropic/client.js';

/**
 * Convert a content value (string OR Anthropic content-block array) into a
 * single text string suitable for token estimation, retention, transcripts,
 * and log lines. Image / document blocks are rendered as short
 * `[image: <media_type>]` / `[document: <media_type>]` placeholders so the
 * binary payload never bloats Hindsight or summary requests.
 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as ContentBlock;
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text);
        break;
      case 'image': {
        const mt = block.source?.media_type ?? 'unknown';
        parts.push(`[image: ${mt}]`);
        break;
      }
      case 'document': {
        const mt = block.source?.media_type ?? 'unknown';
        parts.push(`[document: ${mt}]`);
        break;
      }
      case 'thinking':
        if (typeof block.thinking === 'string') parts.push(block.thinking);
        break;
      case 'tool_use':
        parts.push(`[tool_use: ${block.name ?? 'unknown'}]`);
        break;
      case 'tool_result':
        if (typeof block.content === 'string') parts.push(block.content);
        else parts.push('[tool_result]');
        break;
      default:
        break;
    }
  }
  return parts.join('\n');
}

/**
 * True when content is a non-empty Anthropic content-block array (i.e.
 * something other than a plain string transcript).
 */
export function isContentBlockArray(content: unknown): content is ContentBlock[] {
  return Array.isArray(content) && content.length > 0;
}
