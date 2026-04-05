import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)]">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold text-zinc-100">404</h1>
        <p className="text-zinc-400">Page not found</p>
        <Link
          href="/"
          className="inline-block rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
