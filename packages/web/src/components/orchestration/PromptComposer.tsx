'use client';

/**
 * @module PromptComposer
 * Reusable prompt input that mirrors the chat composer's UX:
 *  - Auto-growing textarea
 *  - Paperclip button + hidden file input
 *  - Drag-and-drop overlay
 *  - Attachment chip list (image previews / coloured FileText icons)
 *  - Per-attachment remove
 *
 * Used by the scheduler form so a saved prompt can carry the same
 * file attachments the user would have dropped into chat. Controlled:
 * the parent owns `value` (text) and `attachments` and receives changes
 * via `onChange`.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Paperclip, X, FileText } from 'lucide-react';
import { uuid } from '@/lib/uuid';
import { formatBytes } from '@/utils/format';
import {
  ACCEPTED_FILE_TYPES,
  isAcceptedFile,
  isImageType,
  getFileIconColor,
} from '@/lib/file-types';
import type { FileAttachment } from '@/components/chat/ChatInput';

interface PromptComposerProps {
  value: string;
  onChange: (next: string) => void;
  attachments: FileAttachment[];
  onAttachmentsChange: (next: FileAttachment[]) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Min textarea rows when empty. */
  rows?: number;
  /** Max textarea height in px before it scrolls. */
  maxHeightPx?: number;
}

const DEFAULT_MAX_HEIGHT_PX = 256;

export function PromptComposer({
  value,
  onChange,
  attachments,
  onAttachmentsChange,
  placeholder,
  disabled,
  rows = 4,
  maxHeightPx = DEFAULT_MAX_HEIGHT_PX,
}: PromptComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Track every blob: preview URL we minted via URL.createObjectURL so we
  // can guarantee revocation on unmount even after `attachments` mutates.
  // We *only* revoke blob: URLs; hydrated previews from a saved schedule
  // pass the original DataURL through `previewUrl` and must not be revoked.
  const ownedBlobUrlsRef = useRef<Set<string>>(new Set());

  // Auto-grow textarea on value change.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeightPx)}px`;
  }, [value, maxHeightPx]);

  // Unmount: revoke every blob URL we ever created in this composer's
  // lifetime, regardless of whether it's still in `attachments`.
  useEffect(() => {
    const owned = ownedBlobUrlsRef.current;
    return () => {
      owned.forEach((url) => URL.revokeObjectURL(url));
      owned.clear();
    };
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const valid = Array.from(files).filter(isAcceptedFile);
      if (valid.length === 0) return;
      const next: FileAttachment[] = valid.map((file) => {
        let previewUrl: string | undefined;
        if (isImageType(file.type)) {
          previewUrl = URL.createObjectURL(file);
          ownedBlobUrlsRef.current.add(previewUrl);
        }
        return {
          id: uuid(),
          file,
          name: file.name,
          size: file.size,
          type: file.type,
          previewUrl,
        };
      });
      onAttachmentsChange([...attachments, ...next]);
    },
    [attachments, onAttachmentsChange],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      const target = attachments.find((a) => a.id === id);
      // Only revoke previews we own (blob:); hydrated DataURL previews must stay valid.
      if (target?.previewUrl && ownedBlobUrlsRef.current.has(target.previewUrl)) {
        URL.revokeObjectURL(target.previewUrl);
        ownedBlobUrlsRef.current.delete(target.previewUrl);
      }
      onAttachmentsChange(attachments.filter((a) => a.id !== id));
    },
    [attachments, onAttachmentsChange],
  );

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) setIsDraggingOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDraggingOver(false);
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDraggingOver(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        addFiles(e.target.files);
        e.target.value = '';
      }
    },
    [addFiles],
  );

  return (
    <div
      className={`relative flex flex-col gap-2 transition-colors ${isDraggingOver ? 'rounded bg-blue-950/20' : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDraggingOver && (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded border-2 border-dashed border-blue-500 bg-blue-950/30"
        >
          <p className="text-xs font-medium text-blue-400">Drop files to attach</p>
        </div>
      )}

      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2" role="list" aria-label="Attached files">
          {attachments.map((a) => (
            <div
              key={a.id}
              role="listitem"
              className="group relative flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300"
            >
              {isImageType(a.type) && a.previewUrl ? (
                <>
                  <img src={a.previewUrl} alt={a.name} className="h-8 w-8 rounded object-cover" />
                  <span className="max-w-[120px] truncate" title={a.name}>{a.name}</span>
                </>
              ) : (
                <>
                  <FileText size={14} className={`shrink-0 ${getFileIconColor(a.type)}`} aria-hidden="true" />
                  <span className="max-w-[120px] truncate" title={a.name}>{a.name}</span>
                  <span className="text-zinc-500">{formatBytes(a.size)}</span>
                </>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                className="ml-1 rounded text-zinc-500 hover:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                aria-label={`Remove ${a.name}`}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_FILE_TYPES}
        onChange={handleFileInputChange}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* Textarea + paperclip in a single bordered container, mirroring chat */}
      <div className="flex items-end gap-2 rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 focus-within:border-emerald-500/60">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          rows={rows}
          className="flex-1 resize-none bg-transparent text-xs leading-relaxed text-zinc-200 placeholder-zinc-500 outline-none disabled:opacity-50"
          style={{ maxHeight: maxHeightPx }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-30 focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
          aria-label="Attach files"
          title="Attach files (or drag and drop)"
        >
          <Paperclip size={14} />
        </button>
      </div>
    </div>
  );
}
