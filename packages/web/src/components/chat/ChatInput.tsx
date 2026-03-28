'use client';

import { useState, useCallback, useRef, useEffect, type KeyboardEvent, type DragEvent } from 'react';
import { Send, Command, X, Reply, Paperclip, FileText, Image } from 'lucide-react';
import { useChatStore } from '@/stores/chat';

export interface FileAttachment {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  previewUrl?: string; // for images
}

interface ChatInputProps {
  onSend: (text: string, replyToId?: string, attachments?: FileAttachment[]) => void;
  disabled?: boolean;
}

const BUILTIN_COMMANDS = [
  { command: '/stop', description: 'Stop current streaming' },
  { command: '/clear', description: 'Clear conversation' },
  { command: '/status', description: 'Show system status' },
  { command: '/update', description: 'Pull latest, rebuild, and restart' },
  { command: '/help', description: 'Show available commands' },
];

function useFileCommands() {
  const [fileCommands, setFileCommands] = useState<Array<{ command: string; description: string }>>([]);

  useEffect(() => {
    fetch('/api/gateway/api/commands')
      .then((res) => (res.ok ? res.json() : { commands: [] }))
      .then((data: { commands: Array<{ name: string; description: string }> }) => {
        setFileCommands(
          data.commands.map((c) => ({
            command: `/${c.name}`,
            description: c.description,
          })),
        );
      })
      .catch(() => {});
  }, []);

  return fileCommands;
}

const TEXTAREA_MAX_HEIGHT_PX = 256; // matches Tailwind max-h-64

const ACCEPTED_FILE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/javascript',
  'text/typescript',
  'text/x-python',
  'text/x-go',
  'text/x-rust',
].join(',');

const ACCEPTED_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|pdf|txt|md|js|ts|jsx|tsx|py|go|rs|css|html|json|yaml|yml|sh|bash|zsh|rb|java|cpp|c|cs|php|swift|kt|scala)$/i;

function isImageType(type: string): boolean {
  return type.startsWith('image/');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [showPalette, setShowPalette] = useState(false);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const messages = useChatStore((s) => s.messages);
  const replyTarget = useChatStore((s) => s.replyTarget);
  const setReplyTarget = useChatStore((s) => s.setReplyTarget);
  const fileCommands = useFileCommands();
  const SLASH_COMMANDS = [...BUILTIN_COMMANDS, ...fileCommands];

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      attachments.forEach((a) => {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const valid = fileArray.filter(
      (f) => ACCEPTED_EXTENSIONS.test(f.name) || f.type.startsWith('image/') || f.type === 'application/pdf' || f.type.startsWith('text/'),
    );
    const newAttachments: FileAttachment[] = valid.map((file) => {
      const id = crypto.randomUUID();
      const previewUrl = isImageType(file.type) ? URL.createObjectURL(file) : undefined;
      return { id, file, name: file.name, size: file.size, type: file.type, previewUrl };
    });
    setAttachments((prev) => [...prev, ...newAttachments]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;
    onSend(trimmed, replyTarget?.messageId, attachments.length > 0 ? attachments : undefined);
    setInput('');
    setAttachments([]);
    setShowPalette(false);
    setReplyTarget(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input, disabled, onSend, attachments, replyTarget, setReplyTarget]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    if (e.key === 'ArrowUp' && input === '') {
      e.preventDefault();
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUserMsg) {
        setInput(lastUserMsg.content);
        setTimeout(() => {
          const ta = textareaRef.current;
          if (ta) ta.selectionStart = ta.selectionEnd = ta.value.length;
        }, 0);
      }
      return;
    }
  };

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setShowPalette((p) => !p);
        textareaRef.current?.focus();
      }
      if (e.key === 'Escape' && useChatStore.getState().isStreaming) {
        e.preventDefault();
        onSend('/stop');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onSend]);

  const selectCommand = (cmd: string) => {
    setInput(cmd);
    setShowPalette(false);
    textareaRef.current?.focus();
  };

  // Drag-and-drop handlers
  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
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
        // Reset input so the same file can be re-selected
        e.target.value = '';
      }
    },
    [addFiles],
  );

  const adjustTextareaHeight = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  const canSend = (input.trim().length > 0 || attachments.length > 0) && !disabled;

  return (
    <div
      className={`relative px-6 py-4 transition-colors ${
        isDraggingOver ? 'bg-blue-950/20' : ''
      }`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      aria-label="Chat input area — drop files here to attach"
    >
      {isDraggingOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-500 bg-blue-950/30">
          <p className="text-sm font-medium text-blue-400">Drop files to attach</p>
        </div>
      )}

      {replyTarget && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-2">
          <Reply size={14} className="shrink-0 text-blue-400" />
          <div className="min-w-0 flex-1 text-xs text-zinc-300">
            <span className="font-medium text-zinc-400">
              Replying to {replyTarget.role === 'user' ? 'yourself' : 'Assistant'}
            </span>
            <p className="mt-0.5 truncate text-zinc-500">{replyTarget.content.replace(/\n/g, ' ').slice(0, 120)}</p>
          </div>
          <button
            onClick={() => setReplyTarget(null)}
            className="shrink-0 text-zinc-500 hover:text-zinc-300"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {showPalette && (
        <div className="absolute bottom-full left-6 right-6 mb-2 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
            <span className="text-xs font-medium text-zinc-400">Commands</span>
            <button
              onClick={() => setShowPalette(false)}
              className="text-zinc-500 hover:text-zinc-300"
              aria-label="Close command palette"
            >
              <X size={14} />
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto py-1">
            {SLASH_COMMANDS.map((cmd) => (
              <button
                key={cmd.command}
                onClick={() => selectCommand(cmd.command)}
                className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-zinc-800"
              >
                <code className="text-xs text-blue-400">{cmd.command}</code>
                <span className="text-xs text-zinc-500">{cmd.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* File attachment previews */}
      {attachments.length > 0 && (
        <div
          className="mb-3 flex flex-wrap gap-2"
          role="list"
          aria-label="Attached files"
        >
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              role="listitem"
              className="group relative flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300"
            >
              {isImageType(attachment.type) && attachment.previewUrl ? (
                <>
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="h-8 w-8 rounded object-cover"
                  />
                  <span className="max-w-[120px] truncate" title={attachment.name}>
                    {attachment.name}
                  </span>
                </>
              ) : (
                <>
                  {attachment.type === 'application/pdf' ? (
                    <FileText size={14} className="shrink-0 text-red-400" aria-hidden="true" />
                  ) : (
                    <FileText size={14} className="shrink-0 text-zinc-400" aria-hidden="true" />
                  )}
                  <span className="max-w-[120px] truncate" title={attachment.name}>
                    {attachment.name}
                  </span>
                  <span className="text-zinc-500">{formatBytes(attachment.size)}</span>
                </>
              )}
              <button
                onClick={() => removeAttachment(attachment.id)}
                className="ml-1 rounded text-zinc-500 hover:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                aria-label={`Remove ${attachment.name}`}
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

      <div className="flex items-end gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 focus-within:border-blue-600">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message OmegaClaw..."
          disabled={disabled}
          rows={1}
          className="max-h-64 flex-1 resize-none bg-transparent text-sm leading-relaxed text-zinc-100 placeholder-zinc-500 outline-none transition-[height] duration-150 ease-out disabled:opacity-50"
          aria-label="Message input"
          aria-multiline="true"
        />

        {/* Paperclip / attach button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:ring-offset-zinc-900"
          aria-label="Attach files"
          title="Attach files"
        >
          <Paperclip size={16} />
        </button>

        <button
          onClick={handleSend}
          disabled={!canSend}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:opacity-30 disabled:hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1 focus:ring-offset-zinc-900"
          aria-label="Send message"
        >
          <Send size={16} />
        </button>
      </div>

      <p className="mt-2 text-center text-xs text-zinc-600">
        Enter to send · Shift+Enter for new line · Esc to stop ·{' '}
        <span className="inline-flex items-center gap-0.5">
          <Command size={10} className="inline" />/
        </span>{' '}
        commands · <Paperclip size={10} className="inline" /> to attach files
      </p>
    </div>
  );
}
