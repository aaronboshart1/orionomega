'use client';

import { useEffect } from 'react';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// global-error.tsx catches errors thrown by the root layout/template.
// It MUST define its own <html>/<body> because it replaces the root layout entirely.
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    // Log to error reporting service in production
    console.error('[app/global-error]', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#09090b',
          color: '#fafafa',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center', padding: '1.5rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.75rem' }}>
            Application error
          </h1>
          <p style={{ fontSize: '0.875rem', color: '#a1a1aa', marginBottom: '0.75rem' }}>
            A critical error occurred. Please try reloading the page.
          </p>
          {error.digest && (
            <p style={{ fontSize: '0.75rem', color: '#52525b', fontFamily: 'monospace', marginBottom: '1rem' }}>
              Error ID: {error.digest}
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button
              onClick={reset}
              style={{
                padding: '0.5rem 1rem',
                border: '1px solid #3f3f46',
                borderRadius: '0.5rem',
                background: '#27272a',
                color: '#e4e4e7',
                fontSize: '0.875rem',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '0.5rem 1rem',
                border: '1px solid #3f3f46',
                borderRadius: '0.5rem',
                background: '#27272a',
                color: '#e4e4e7',
                fontSize: '0.875rem',
                cursor: 'pointer',
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
