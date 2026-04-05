import { create } from 'zustand';
import { requestFileRead } from '@/lib/gateway';

export interface OpenFile {
  path: string;
  label: string;
  content: string;
  loading?: boolean;
  error?: string;
}

interface FileViewerStore {
  openFiles: OpenFile[];
  activeFilePath: string | null;
  openFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

export const useFileViewerStore = create<FileViewerStore>()((set, get) => ({
  openFiles: [],
  activeFilePath: null,

  openFile: async (path: string) => {
    const existing = get().openFiles.find((f) => f.path === path);
    if (existing && !existing.error) {
      set({ activeFilePath: path });
      return;
    }

    const label = basename(path);
    set((s) => ({
      openFiles: existing
        ? s.openFiles.map((f) => (f.path === path ? { ...f, loading: true, error: undefined } : f))
        : [...s.openFiles, { path, label, content: '', loading: true }],
      activeFilePath: path,
    }));

    try {
      const result = await requestFileRead(path);
      if (result.error) {
        set((s) => ({
          openFiles: s.openFiles.map((f) =>
            f.path === path ? { ...f, loading: false, error: result.error } : f,
          ),
        }));
        return;
      }
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path ? { ...f, content: result.content ?? '', loading: false, error: undefined } : f,
        ),
      }));
    } catch (err) {
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path
            ? { ...f, loading: false, error: err instanceof Error ? err.message : 'Request failed' }
            : f,
        ),
      }));
    }
  },

  closeFile: (path: string) =>
    set((s) => {
      const remaining = s.openFiles.filter((f) => f.path !== path);
      let newActive = s.activeFilePath;
      if (s.activeFilePath === path) {
        newActive = remaining.length > 0 ? remaining[remaining.length - 1].path : null;
      }
      return { openFiles: remaining, activeFilePath: newActive };
    }),

  setActiveFile: (path: string) => set({ activeFilePath: path }),
}));
