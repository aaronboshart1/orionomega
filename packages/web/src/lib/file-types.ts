/**
 * Supported file types for Claude API uploads.
 *
 * Claude supports two upload mechanisms via the Messages API:
 *   - image content blocks  → image/jpeg, image/png, image/gif, image/webp
 *   - document content blocks → application/pdf + all text/* types
 *
 * Binary office formats (docx, xlsx, pptx) are accepted by Claude's API
 * via document content blocks and are sent as base64-encoded data.
 *
 * Text-based source/config/data files are sent as UTF-8 text.
 */

// ---------------------------------------------------------------------------
// Images — sent as image content blocks (Claude 3+)
// ---------------------------------------------------------------------------

/** MIME types for images supported by Claude vision */
export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

// ---------------------------------------------------------------------------
// Binary documents — sent as base64-encoded document content blocks
// ---------------------------------------------------------------------------

/** MIME types for binary document formats supported by Claude */
export const BINARY_DOCUMENT_MIME_TYPES = [
  'application/pdf',                                                                     // .pdf
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',             // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',                   // .xlsx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',           // .pptx
] as const;

// ---------------------------------------------------------------------------
// Text documents — sent as UTF-8 text document content blocks
// ---------------------------------------------------------------------------

/**
 * text/* MIME types supported by Claude for document uploads.
 * Covers plain text, markup, web, and programming language source files.
 */
export const TEXT_MIME_TYPES = [
  // Generic text
  'text/plain',         // .txt, .text, .log, .cfg, .conf, .ini, .env
  // Markup / web
  'text/html',          // .html, .htm
  'text/css',           // .css
  'text/xml',           // .xml
  'text/csv',           // .csv
  'text/markdown',      // .md, .markdown, .mdx
  // JavaScript / TypeScript
  'text/javascript',    // .js, .mjs, .cjs
  'text/typescript',    // .ts, .tsx, .mts, .cts
  // Programming languages
  'text/x-python',      // .py, .pyw
  'text/x-java',        // .java
  'text/x-ruby',        // .rb
  'text/x-php',         // .php
  'text/x-c',           // .c, .h
  'text/x-c++src',      // .cpp, .cc, .cxx, .hpp, .hxx
  'text/x-csharp',      // .cs
  'text/x-go',          // .go
  'text/x-rust',        // .rs
  'text/x-swift',       // .swift
  'text/x-kotlin',      // .kt, .kts
  'text/x-scala',       // .scala
  'text/x-shellscript', // .sh, .bash, .zsh
] as const;

/**
 * application/* MIME types that contain text-based content.
 * These are treated the same as text/* when reading file contents.
 */
export const APPLICATION_TEXT_MIME_TYPES = [
  'application/json',        // .json, .jsonl
  'application/xml',         // .xml, .xsl, .xslt
  'application/javascript',  // .js
  'application/x-yaml',      // .yaml, .yml
  'application/x-toml',      // .toml
] as const;

// ---------------------------------------------------------------------------
// Combined lists
// ---------------------------------------------------------------------------

/** All supported document MIME types (binary + text) */
export const ALL_DOCUMENT_MIME_TYPES = [
  ...BINARY_DOCUMENT_MIME_TYPES,
  ...TEXT_MIME_TYPES,
  ...APPLICATION_TEXT_MIME_TYPES,
] as const;

/**
 * Accept string for the <input accept> attribute.
 * Includes both MIME types and file extensions for maximum browser compatibility
 * (some OS/browser combos don't reliably map extensions to MIME types).
 */
export const ACCEPTED_FILE_TYPES = [
  // Images
  ...IMAGE_MIME_TYPES,
  // Binary documents
  ...BINARY_DOCUMENT_MIME_TYPES,
  // Text/* MIME types
  ...TEXT_MIME_TYPES,
  // Application text MIME types
  ...APPLICATION_TEXT_MIME_TYPES,
  // Extension fallbacks for types with unreliable MIME detection
  '.txt', '.text', '.log', '.cfg', '.conf', '.ini', '.env',
  '.md', '.markdown', '.mdx',
  '.json', '.jsonl',
  '.yaml', '.yml',
  '.toml',
  '.sh', '.bash', '.zsh',
  '.py', '.pyw',
  '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.mts', '.cts',
  '.jsx',
  '.java', '.rb', '.php',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx',
  '.cs', '.go', '.rs', '.swift',
  '.kt', '.kts', '.scala',
  '.html', '.htm', '.css', '.xml', '.xsl', '.xslt',
  '.csv', '.sql',
  '.docx', '.xlsx', '.pptx',
].join(',');

/**
 * Extension regex covering all supported file types.
 * Used as a fallback filter when MIME type is absent or unreliable.
 */
export const ACCEPTED_EXTENSIONS =
  /\.(jpg|jpeg|png|gif|webp|pdf|docx|xlsx|pptx|txt|text|log|cfg|conf|ini|env|html|htm|css|js|mjs|cjs|ts|tsx|mts|cts|jsx|csv|xml|xsl|xslt|md|markdown|mdx|py|pyw|java|rb|php|c|h|cpp|cc|cxx|hpp|hxx|cs|go|rs|swift|kt|kts|scala|sh|bash|zsh|json|jsonl|yaml|yml|toml|sql)$/i;

// ---------------------------------------------------------------------------
// Type guards and helpers
// ---------------------------------------------------------------------------

/** Returns true if the MIME type is a supported image */
export function isImageType(type: string): boolean {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(type);
}

/** Returns true if the MIME type is a binary document (PDF or Office format) */
export function isBinaryDocument(type: string): boolean {
  return (BINARY_DOCUMENT_MIME_TYPES as readonly string[]).includes(type);
}

/** Returns true if the MIME type is text-based (readable as UTF-8) */
export function isTextType(type: string): boolean {
  return (
    type.startsWith('text/') ||
    (APPLICATION_TEXT_MIME_TYPES as readonly string[]).includes(type)
  );
}

/** Returns true if a file should be accepted for upload */
export function isAcceptedFile(file: File): boolean {
  return (
    ACCEPTED_EXTENSIONS.test(file.name) ||
    isImageType(file.type) ||
    isBinaryDocument(file.type) ||
    isTextType(file.type)
  );
}

/**
 * Returns the Tailwind CSS color class for a file attachment icon
 * based on its MIME type.
 */
export function getFileIconColor(type: string): string {
  if (type === 'application/pdf') return 'text-red-400';
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'text-blue-400';
  if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'text-green-400';
  if (type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'text-orange-400';
  if (type === 'application/json' || type === 'application/x-yaml' || type === 'application/x-toml') return 'text-yellow-400';
  return 'text-zinc-400';
}

/**
 * Returns a short human-readable label for a MIME type,
 * useful for aria labels and tooltips.
 */
export function getFileTypeLabel(type: string): string {
  if (isImageType(type)) return 'Image';
  if (type === 'application/pdf') return 'PDF';
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'Word document';
  if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'Excel spreadsheet';
  if (type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'PowerPoint presentation';
  if (type === 'application/json') return 'JSON';
  if (type === 'application/x-yaml') return 'YAML';
  if (type === 'application/x-toml') return 'TOML';
  if (type === 'text/markdown') return 'Markdown';
  if (type === 'text/csv') return 'CSV';
  if (type === 'text/html') return 'HTML';
  if (type === 'text/css') return 'CSS';
  if (type.startsWith('text/x-')) return type.replace('text/x-', '').replace('++src', '++').replace('src', '') + ' source';
  if (type.startsWith('text/')) return 'Text';
  return 'File';
}
