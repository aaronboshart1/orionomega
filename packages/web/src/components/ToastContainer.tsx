'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useToastStore, type Toast } from '@/stores/toast';
import { Z } from '@/lib/z-index';

const variantStyles: Record<Toast['variant'], string> = {
  info: 'border-blue-500/40 bg-blue-950/90 text-blue-200',
  success: 'border-green-500/40 bg-green-950/90 text-green-200',
  error: 'border-red-500/40 bg-red-950/90 text-red-200',
  warning: 'border-amber-500/40 bg-amber-950/90 text-amber-200',
};

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useToastStore((s) => s.removeToast);

  useEffect(() => {
    const timer = setTimeout(() => removeToast(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, removeToast]);

  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur-sm animate-toast-in ${variantStyles[toast.variant]}`}
    >
      <span className="flex-1">{toast.message}</span>
      <button
        onClick={() => removeToast(toast.id)}
        className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-4 flex flex-col items-center gap-2 px-4"
      style={{ zIndex: Z.toast }}
    >
      <div className="pointer-events-auto flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </div>
    </div>
  );
}
