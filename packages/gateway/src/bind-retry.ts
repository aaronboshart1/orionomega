/**
 * Resilient port-binding helper for the gateway HTTP server.
 *
 * Replaces the legacy fixed 10×2s `setupServerForAddress` retry loop. The
 * old loop gave up after ~20s and called `process.exit(1)` whenever a brief
 * EADDRINUSE overlap with a dying predecessor stretched past that window —
 * which is exactly what happens during a normal supervisor restart, because
 * the previous gateway can take several seconds to flush keep-alives and
 * fully release the socket. The supervisor would then respawn the gateway,
 * which would hit the same race and crash again, producing an indefinite
 * `All bind addresses failed — exiting` log loop.
 *
 * This helper retries with gentle exponential backoff (1s → 2s → 4s, capped
 * at `maxDelayMs`) inside a configurable total time budget (default 60s,
 * overridable via `ORIONOMEGA_BIND_RETRY_MS`). It honors an `AbortSignal`
 * so SIGTERM during a retry cancels cleanly without re-listening on a port
 * the shutdown sequence is about to release.
 */

export interface ServerLike {
  listen(port: number, address: string): void;
  once(event: 'listening' | 'error', cb: (...args: unknown[]) => void): unknown;
  removeListener(event: 'listening' | 'error', cb: (...args: unknown[]) => void): unknown;
}

export interface BindWithRetryOptions {
  port: number;
  address: string;
  /** Total time budget for retries, in ms. Default 60_000. */
  totalBudgetMs?: number;
  /** Initial backoff delay, in ms. Default 1_000. */
  initialDelayMs?: number;
  /** Max backoff delay, in ms. Default 5_000. */
  maxDelayMs?: number;
  /** Aborts the retry loop (e.g. on SIGTERM). */
  signal?: AbortSignal;
  /** Injectable timer for tests. Defaults to `setTimeout`/`clearTimeout`. */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Called on each retry (after EADDRINUSE) for logging. */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    elapsedMs: number;
    err: NodeJS.ErrnoException;
  }) => void;
}

export interface BindWithRetrySuccess {
  ok: true;
  attempts: number;
  elapsedMs: number;
}

export interface BindWithRetryFailure {
  ok: false;
  /**
   * - `'shutdown'`  : abort signal fired before/between attempts.
   * - `'giveup'`    : EADDRINUSE persisted past `totalBudgetMs`.
   * - `'fatal'`     : non-EADDRINUSE error from `listen()` (no retry).
   */
  reason: 'shutdown' | 'giveup' | 'fatal';
  attempts: number;
  elapsedMs: number;
  lastErr?: NodeJS.ErrnoException;
}

export type BindWithRetryResult = BindWithRetrySuccess | BindWithRetryFailure;

/**
 * Default total retry window. Long enough to outlast a graceful shutdown of
 * the previous gateway (which can take 5s for the WS deadline + 5s for the
 * shutdown deadline + several more seconds for kernel TIME_WAIT cleanup),
 * even on a slow host.
 */
export const DEFAULT_BIND_RETRY_BUDGET_MS = 60_000;

/**
 * Build the single consolidated terminal error line emitted when no bind
 * address succeeded. Captures attempts and measured elapsed time per
 * address, plus the last errno seen, so a support engineer can tell at a
 * glance whether they hit `EADDRINUSE` for the full retry window vs. a
 * permission error on the very first attempt.
 */
export function formatAllBindsFailedMessage(opts: {
  port: number;
  budgetMs: number;
  outcomes: ReadonlyArray<{
    address: string;
    reason?: 'shutdown' | 'giveup' | 'fatal';
    attempts: number;
    elapsedMs: number;
    lastErrCode?: string;
    lastErrMessage?: string;
  }>;
}): string {
  // If every address failed on attempt 1 with a non-EADDRINUSE error, the
  // "after Ns of retries" phrasing is misleading — say "on first attempt"
  // instead so support reads the right diagnosis.
  const onlyFatal = opts.outcomes.every((o) => o.reason === 'fatal' && o.attempts <= 1);
  const perAddr = opts.outcomes
    .map((o) => {
      const code = o.lastErrCode ?? 'UNKNOWN';
      const elapsedSec = Math.round(o.elapsedMs / 100) / 10;
      return `${o.address}: ${code} after ${o.attempts} attempt(s), ${elapsedSec}s`;
    })
    .join('; ');
  const addrs = opts.outcomes.map((o) => o.address).join(', ');
  if (onlyFatal) {
    return `Failed to bind to [${addrs}]:${opts.port} on first attempt — exiting (${perAddr})`;
  }
  return (
    `Failed to bind to [${addrs}]:${opts.port} after ` +
    `${Math.round(opts.budgetMs / 1000)}s budget — exiting (${perAddr})`
  );
}

/** Parse the env override. Returns the default if missing/invalid. */
export function resolveBindRetryBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORIONOMEGA_BIND_RETRY_MS;
  if (!raw) return DEFAULT_BIND_RETRY_BUDGET_MS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BIND_RETRY_BUDGET_MS;
  return parsed;
}

/**
 * Attempt `srv.listen(port, address)` with bounded EADDRINUSE retries.
 *
 * Resolves with `{ ok: true }` on the first 'listening' event. Resolves with
 * `{ ok: false }` only after the budget is exhausted (`giveup`), the abort
 * signal fires (`shutdown`), or a non-recoverable error is observed
 * (`fatal`). Never throws.
 */
export async function bindWithRetry(
  srv: ServerLike,
  opts: BindWithRetryOptions,
): Promise<BindWithRetryResult> {
  const totalBudgetMs = opts.totalBudgetMs ?? DEFAULT_BIND_RETRY_BUDGET_MS;
  const initialDelayMs = opts.initialDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const now = opts.now ?? (() => Date.now());
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(t) };
    });

  const start = now();
  let attempts = 0;
  let lastErr: NodeJS.ErrnoException | undefined;

  while (true) {
    if (opts.signal?.aborted) {
      return { ok: false, reason: 'shutdown', attempts, elapsedMs: now() - start, lastErr };
    }

    attempts++;
    const result = await new Promise<{ ok: true } | { ok: false; err: NodeJS.ErrnoException }>(
      (resolve) => {
        const onListening = () => {
          srv.removeListener('error', onError as (...a: unknown[]) => void);
          resolve({ ok: true });
        };
        const onError = (err: NodeJS.ErrnoException) => {
          srv.removeListener('listening', onListening as (...a: unknown[]) => void);
          resolve({ ok: false, err });
        };
        srv.once('listening', onListening as (...a: unknown[]) => void);
        srv.once('error', onError as (...a: unknown[]) => void);
        srv.listen(opts.port, opts.address);
      },
    );

    if (result.ok) {
      return { ok: true, attempts, elapsedMs: now() - start };
    }

    lastErr = result.err;

    if (result.err.code !== 'EADDRINUSE') {
      return { ok: false, reason: 'fatal', attempts, elapsedMs: now() - start, lastErr };
    }

    const elapsed = now() - start;
    const remaining = totalBudgetMs - elapsed;
    if (remaining <= 0) {
      return { ok: false, reason: 'giveup', attempts, elapsedMs: elapsed, lastErr };
    }

    // Exponential backoff: 1s, 2s, 4s, … capped at maxDelayMs. Never wait
    // past the remaining budget.
    const backoff = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempts - 1));
    const delayMs = Math.min(backoff, remaining);

    opts.onRetry?.({ attempt: attempts, delayMs, elapsedMs: elapsed, err: result.err });

    await new Promise<void>((resolve) => {
      const handle = setTimer(() => {
        opts.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        handle.cancel();
        resolve();
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          handle.cancel();
          resolve();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}
