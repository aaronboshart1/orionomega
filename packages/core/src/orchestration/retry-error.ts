/**
 * Lightweight tagged error type so the SDK bridge can hand the executor an
 * explicit retry decision (instead of forcing classifyError to guess from a
 * message string). Lives in its own module to avoid a circular import between
 * executor.ts ↔ worker.ts ↔ agent-sdk-bridge.ts.
 */

export class TaggedRetryError extends Error {
  readonly retryable: boolean;
  readonly errorSubtype?: string;
  constructor(message: string, opts: { retryable: boolean; errorSubtype?: string }) {
    super(message);
    this.name = 'TaggedRetryError';
    this.retryable = opts.retryable;
    this.errorSubtype = opts.errorSubtype;
  }
}
