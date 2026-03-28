import { create } from 'zustand';

export type ToastVariant = 'info' | 'success' | 'error' | 'warning';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (message: string, variant?: ToastVariant, duration?: number) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (message, variant = 'info', duration = 4000) => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, message, variant, duration }] }));
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
