'use client';

import { useEffect } from 'react';
import Link from 'next/link';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Log to error reporting service in production
    console.error('[app/error]', error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)]">
      <div className="text-center space-y-4 p-6">
        <h2 className="text-xl font-semibold text-zinc-100">Something went wrong</h2>
        <p className="text-sm text-zinc-400">
          {/* In production Next.js obscures the real message; only show it in dev */}
          {process.env.NODE_ENV === 'development'
            ? error.message
            : 'An unexpected error occurred.'}
        </p>
        {error.digest && (
          <p className="text-xs text-zinc-600 font-mono">Error ID: {error.digest}</p>
        )}
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
