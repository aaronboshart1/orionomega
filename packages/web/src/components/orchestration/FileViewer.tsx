'use client';

import { X, Loader2, AlertCircle } from 'lucide-react';
import { useFileViewerStore } from '@/stores/file-viewer';
import { MarkdownContent } from '../chat/MarkdownContent';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export function FileViewer() {
  const openFiles = useFileViewerStore((s) => s.openFiles);
  const activeFilePath = useFileViewerStore((s) => s.activeFilePath);
  const closeFile = useFileViewerStore((s) => s.closeFile);
  const setActiveFile = useFileViewerStore((s) => s.setActiveFile);

  const activeFile = openFiles.find((f) => f.path === activeFilePath);

  if (openFiles.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        No files open
      </div>
    );
  }

  const isMarkdown = activeFile?.path.endsWith('.md');

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-zinc-800 px-1 py-1">
        {openFiles.map((file) => (
          <div
            key={file.path}
            className={`group flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs cursor-pointer transition-colors ${
              file.path === activeFilePath
                ? 'bg-zinc-800 text-zinc-200 ring-1 ring-zinc-600'
                : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
            }`}
            onClick={() => setActiveFile(file.path)}
            title={file.path}
          >
            <span className="max-w-[160px] truncate">{file.label}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeFile(file.path);
              }}
              className="rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-300 group-hover:opacity-100"
              aria-label={`Close ${file.label}`}
            >
              <X size={10} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeFile?.loading && (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-zinc-500">
            <Loader2 size={14} className="animate-spin" />
            Loading file…
          </div>
        )}

        {activeFile?.error && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-red-400">
            <AlertCircle size={16} />
            <span>{activeFile.error}</span>
            <span className="text-zinc-600 max-w-[300px] truncate">{activeFile.path}</span>
          </div>
        )}

        {activeFile && !activeFile.loading && !activeFile.error && (
          <div className="px-6 py-4">
            <div className="mb-3 text-[10px] font-mono text-zinc-600 break-all">{activeFile.path}</div>
            {isMarkdown ? (
              <div className="prose-sm text-zinc-200">
                <ErrorBoundary>
                  <MarkdownContent content={activeFile.content} />
                </ErrorBoundary>
              </div>
            ) : (
              <pre className="whitespace-pre-wrap text-xs text-zinc-300 font-mono leading-relaxed">
                {activeFile.content}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
