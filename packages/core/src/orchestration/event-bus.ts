/**
 * @module orchestration/event-bus
 * Event distribution system for worker events with optional throttling.
 */

import type { WorkerEvent } from './types.js';

/** Handler function for worker events. */
export type EventHandler = (event: WorkerEvent) => void | Promise<void>;

/** Configuration for throttled subscriptions. */
export interface ThrottleConfig {
  /** Minimum interval between batched flushes, in milliseconds. */
  throttleMs: number;
  /** Event types that bypass throttling and fire immediately. */
  immediateTypes: string[];
}

/** Default ring buffer capacity. */
const DEFAULT_BUFFER_SIZE = 1000;

/**
 * EventBus distributes WorkerEvents to subscribers with optional throttling.
 *
 * - Stores the last 1000 events in a ring buffer.
 * - Throttled subscribers batch events and flush on interval or on immediate-type events.
 * - Handlers may be async (fire-and-forget).
 */
export class EventBus {
  private readonly channels = new Map<string, Set<EventHandler>>();
  private readonly buffer: WorkerEvent[] = [];
  private readonly bufferSize: number;
  private bufferStart = 0;
  private bufferCount = 0;

  /** Active throttle timers, keyed for cleanup. */
  private readonly throttleTimers = new Set<ReturnType<typeof setInterval>>();

  constructor(bufferSize: number = DEFAULT_BUFFER_SIZE) {
    this.bufferSize = bufferSize;
    this.buffer = new Array<WorkerEvent>(bufferSize);
  }

  /**
   * Subscribe to events on a channel.
   *
   * @param channel - Channel name to subscribe to (e.g. 'workflow-123' or '*' for all).
   * @param handler - Callback invoked for each event.
   * @returns An unsubscribe function.
   */
  subscribe(channel: string, handler: EventHandler): () => void {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    const handlers = this.channels.get(channel)!;
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.channels.delete(channel);
      }
    };
  }

  /**
   * Emit an event to all subscribers on the matching channel and the '*' wildcard channel.
   *
   * @param event - The worker event to emit.
   */
  emit(event: WorkerEvent): void {
    // Store in ring buffer
    const idx = (this.bufferStart + this.bufferCount) % this.bufferSize;
    this.buffer[idx] = event;
    if (this.bufferCount < this.bufferSize) {
      this.bufferCount++;
    } else {
      this.bufferStart = (this.bufferStart + 1) % this.bufferSize;
    }

    // Dispatch to channel-specific and wildcard subscribers
    const targets = [
      this.channels.get(event.nodeId),
      this.channels.get(event.workerId),
      this.channels.get('*'),
    ];

    for (const handlers of targets) {
      if (handlers) {
        for (const handler of handlers) {
          try {
            const result = handler(event);
            // Fire-and-forget for async handlers
            if (result && typeof (result as Promise<void>).catch === 'function') {
              (result as Promise<void>).catch(() => {
                // Swallow async errors in handlers
              });
            }
          } catch {
            // Swallow sync errors in handlers
          }
        }
      }
    }
  }

  /**
   * Subscribe with throttled batching.
   *
   * Events are accumulated and flushed to the handler at the configured interval.
   * Events whose type is in `config.immediateTypes` bypass the batch and fire instantly.
   *
   * @param channel - Channel name to subscribe to.
   * @param handler - Callback invoked with each event (either immediately or on flush).
   * @param config - Throttle configuration.
   * @returns An unsubscribe function that also clears the flush timer.
   */
  subscribeThrottled(
    channel: string,
    handler: EventHandler,
    config: ThrottleConfig,
  ): () => void {
    const pendingBatch: WorkerEvent[] = [];
    const immediateSet = new Set(config.immediateTypes);

    const flush = (): void => {
      const events = pendingBatch.splice(0, pendingBatch.length);
      for (const event of events) {
        try {
          const result = handler(event);
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch(() => {});
          }
        } catch {
          // Swallow errors
        }
      }
    };

    const timer = setInterval(flush, config.throttleMs);
    this.throttleTimers.add(timer);

    const wrappedHandler: EventHandler = (event: WorkerEvent) => {
      if (immediateSet.has(event.type)) {
        // Flush any pending batch first, then deliver immediately
        flush();
        return handler(event);
      }
      pendingBatch.push(event);
    };

    const unsubscribe = this.subscribe(channel, wrappedHandler);

    return () => {
      clearInterval(timer);
      this.throttleTimers.delete(timer);
      flush(); // Deliver any remaining events
      unsubscribe();
    };
  }

  /**
   * Returns the most recent events from the ring buffer.
   *
   * @param limit - Maximum number of events to return. Defaults to 50.
   * @returns Array of recent events, newest last.
   */
  getRecentEvents(limit: number = 50): WorkerEvent[] {
    const count = Math.min(limit, this.bufferCount);
    const result: WorkerEvent[] = [];

    const startIdx =
      (this.bufferStart + this.bufferCount - count) % this.bufferSize;

    for (let i = 0; i < count; i++) {
      const idx = (startIdx + i) % this.bufferSize;
      result.push(this.buffer[idx]);
    }

    return result;
  }

  /**
   * Clears all events from the ring buffer and removes all subscribers.
   * Also clears any active throttle timers.
   */
  clear(): void {
    this.bufferStart = 0;
    this.bufferCount = 0;

    for (const timer of this.throttleTimers) {
      clearInterval(timer);
    }
    this.throttleTimers.clear();
    this.channels.clear();
  }
}
