'use client';

import { useState, useCallback, useRef, useEffect, type KeyboardEvent, type DragEvent, type ClipboardEvent } from 'react';
import { Send, Paperclip, X, File, Image, FileText } from 'lucide-react';
import { TextThumbnail, type TextThumbnailItem } from '@/components/ui/text-thumbnail';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A file attached by the user, including its base64-encoded data. */
export interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  /** Base64-encoded file content (no data-URL prefix). */
  data: string;
}

interface ChatInputProps {
  onSend: (text: string, files?: AttachedFile[]) => void;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CHARS = 4000;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const THUMBNAIL_THRESHOLD = 500; // chars — pastes larger than this become thumbnails

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith('image/')) return <Image size={12} />;
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return <FileText size={12} />;
  return <File size={12} />;
}

async function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the "data:<mime>;base64," prefix to get raw base64
      const comma = result.indexOf(',');
      resolve(comma !== -1 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [thumbnails, setThumbnails] = useState<TextThumbnailItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  // Polite announcement for screen readers when a thumbnail is added
  const [srAnnouncement, setSrAnnouncement] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Counter tracks nested dragenter/dragleave events so we don't flicker
  const dragCounter = useRef(0);

  // Clear SR announcement after it has been read
  useEffect(() => {
    if (!srAnnouncement) return;
    const t = setTimeout(() => setSrAnnouncement(''), 2000);
    return () => clearTimeout(t);
  }, [srAnnouncement]);

  // Auto-resize textarea up to ~8 lines
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseInt(getComputedStyle(el).lineHeight || '20', 10);
    const maxHeight = lineHeight * 8;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [input]);

  // -------------------------------------------------------------------------
  // File processing
  // -------------------------------------------------------------------------

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    const results: AttachedFile[] = [];

    for (const file of list) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        console.warn(`[ChatInput] Skipping ${file.name}: exceeds 10 MB limit`);
        continue;
      }
      try {
        const data = await readFileAsBase64(file);
        results.push({
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          data,
        });
      } catch (err) {
        console.error(`[ChatInput] Could not read ${file.name}:`, err);
      }
    }

    if (results.length > 0) {
      setAttachedFiles((prev) => [...prev, ...results]);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Paste interception
  // -------------------------------------------------------------------------

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text');
    if (text.length > THUMBNAIL_THRESHOLD) {
      e.preventDefault();
      const newItem: TextThumbnailItem = { id: crypto.randomUUID(), text };
      setThumbnails((prev) => [...prev, newItem]);
      const lines = text.split('\n').length;
      setSrAnnouncement(
        `Large text pasted as thumbnail: ${text.length.toLocaleString()} characters, ${lines} line${lines === 1 ? '' : 's'}.`
      );
    }
    // Short pastes fall through to the default textarea behaviour
  }, []);

  const handleRemoveThumbnail = useCallback((id: string) => {
    setThumbnails((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    const thumbnailText = thumbnails.map((t) => t.text).join('\n\n');
    // Thumbnails come first; direct input follows (if any)
    const fullText = [thumbnailText, trimmed].filter(Boolean).join('\n\n');
    const hasFiles = attachedFiles.length > 0;
    if ((!fullText && !hasFiles) || disabled) return;

    onSend(fullText, hasFiles ? attachedFiles : undefined);
    setInput('');
    setAttachedFiles([]);
    setThumbnails([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [input, thumbnails, attachedFiles, disabled, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (e.target.value.length <= MAX_CHARS) setInput(e.target.value);
  };

  // -------------------------------------------------------------------------
  // File input (paperclip button)
  // -------------------------------------------------------------------------

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      processFiles(e.target.files);
      // Reset so the same file can be reattached
      e.target.value = '';
    }
  };

  const handleRemoveFile = (id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  // -------------------------------------------------------------------------
  // Drag-and-drop
  // -------------------------------------------------------------------------

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounter.current += 1;
    if (dragCounter.current === 1 && e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setIsDragging(false);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const charsLeft = MAX_CHARS - input.length;
  const nearLimit = charsLeft < 200;
  const canSend =
    (input.trim().length > 0 || attachedFiles.length > 0 || thumbnails.length > 0) && !disabled;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      className="relative border-t border-zinc-800 px-6 py-4"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Screen-reader live region for thumbnail announcements */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {srAnnouncement}
      </div>

      {/* Drag-over overlay */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-blue-500 bg-blue-500/10 mx-6">
          <div className="flex flex-col items-center gap-1">
            <Paperclip size={20} className="text-blue-400" />
            <p className="text-sm font-medium text-blue-400">Drop to attach</p>
          </div>
        </div>
      )}

      {/* Text thumbnail chips */}
      {thumbnails.length > 0 && (
        <div
          className="mb-2 flex flex-col gap-1.5"
          role="list"
          aria-label="Pasted text thumbnails"
        >
          {thumbnails.map((item) => (
            <div key={item.id} role="listitem">
              <TextThumbnail item={item} onRemove={handleRemoveThumbnail} />
            </div>
          ))}
        </div>
      )}

      {/* Attached file chips */}
      {attachedFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachedFiles.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300"
            >
              <span className="text-zinc-400">
                <FileIcon mimeType={file.type} />
              </span>
              <span className="max-w-[140px] truncate" title={file.name}>
                {file.name}
              </span>
              <span className="text-zinc-500">{formatBytes(file.size)}</span>
              <button
                type="button"
                onClick={() => handleRemoveFile(file.id)}
                aria-label={`Remove ${file.name}`}
                className="ml-0.5 rounded text-zinc-500 transition-colors hover:text-zinc-200"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input row */}
      <div
        className={`flex items-end gap-3 rounded-xl border bg-zinc-900 px-4 py-3 transition-colors focus-within:border-blue-600 ${
          isDragging ? 'border-blue-500 bg-blue-500/5' : 'border-zinc-700'
        }`}
      >
        {/* Paperclip / attach button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          aria-label="Attach file"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-30"
        >
          <Paperclip size={16} />
        </button>

        {/* Hidden native file picker */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
          aria-hidden="true"
          tabIndex={-1}
        />

        {/* Message textarea */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Message OrionOmega..."
          disabled={disabled}
          rows={1}
          aria-label="Chat message input"
          aria-describedby="chat-input-hint"
          className="flex-1 resize-none bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none disabled:opacity-50 leading-5"
          style={{ minHeight: '20px', maxHeight: '160px', overflowY: 'auto' }}
        />

        {/* Send button */}
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          aria-label="Send message"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:opacity-30 disabled:hover:bg-blue-600"
        >
          <Send size={16} />
        </button>
      </div>

      {/* Hint row */}
      <div id="chat-input-hint" className="mt-2 flex items-center justify-between px-1">
        <p className="text-xs text-zinc-600">
          Enter to send · Shift+Enter for newline · Drag &amp; drop or{' '}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="underline underline-offset-2 hover:text-zinc-400 disabled:opacity-30 transition-colors"
          >
            attach files
          </button>
        </p>
        {nearLimit && (
          <p className={`text-xs ${charsLeft < 50 ? 'text-red-400' : 'text-zinc-500'}`}>
            {charsLeft} left
          </p>
        )}
      </div>
    </div>
  );
}
