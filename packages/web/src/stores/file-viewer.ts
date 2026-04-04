import { create } from 'zustand';

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
      const res = await fetch(`/api/gateway/api/files?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Failed to load file' }));
        set((s) => ({
          openFiles: s.openFiles.map((f) =>
            f.path === path ? { ...f, loading: false, error: body.error || `HTTP ${res.status}` } : f,
          ),
        }));
        return;
      }
      const data = await res.json();
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path ? { ...f, content: data.content, loading: false, error: undefined } : f,
        ),
      }));
    } catch (err) {
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path
            ? { ...f, loading: false, error: err instanceof Error ? err.message : 'Network error' }
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
