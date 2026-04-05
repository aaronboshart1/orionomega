export default function Loading() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[var(--background)]">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
        <span className="text-xs text-zinc-500">Loading...</span>
      </div>
    </div>
  );
}
