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

/** Options for EventBus construction. */
export interface EventBusOptions {
  /** Ring buffer capacity (default 1000). */
  bufferSize?: number;
  /**
   * Optional error callback invoked when a handler throws.
   * Receives the error, the event type, and the event itself.
   * If not provided, errors are logged to console.error.
   */
  onError?: (error: unknown, eventType: string, event: WorkerEvent) => void;
}

/** Default ring buffer capacity. */
const DEFAULT_BUFFER_SIZE = 1000;

/**
 * EventBus distributes WorkerEvents to subscribers with optional throttling.
 *
 * - Stores the last N events in a ring buffer.
 * - Throttled subscribers batch events and flush on interval or on immediate-type events.
 * - Handlers may be async (fire-and-forget).
 * - Handler errors are routed to the optional `onError` callback (H2).
 * - Ring buffer overflow increments `droppedEventCount` (M3).
 *
 * Routing in emit():
 *   1. channel matching event.nodeId   — per-node subscriptions
 *   2. channel matching event.workerId — per-worker subscriptions
 *   3. channel matching event.workflowId — per-workflow subscriptions (L1 fix)
 *   4. wildcard '*'                    — global subscriptions
 *
 * [L1] Adding workflowId-keyed routing allows OrchestrationBridge to subscribe
 * per-workflow instead of on '*', eliminating the O(N) wildcard fan-out where
 * every event is delivered to all N workflow handlers.
 */
export class EventBus {
  private readonly channels = new Map<string, Set<EventHandler>>();
  private readonly buffer: WorkerEvent[] = [];
  private readonly bufferSize: number;
  private bufferStart = 0;
  private bufferCount = 0;
  private droppedEventCount = 0;

  /** Optional error handler for subscriber crashes (H2). */
  private readonly onError: ((error: unknown, eventType: string, event: WorkerEvent) => void) | undefined;

  /** Active throttle timers, keyed for cleanup. */
  private readonly throttleTimers = new Set<ReturnType<typeof setInterval>>();

  constructor(optionsOrBufferSize?: number | EventBusOptions) {
    if (typeof optionsOrBufferSize === 'number') {
      // Legacy constructor signature: new EventBus(bufferSize)
      this.bufferSize = optionsOrBufferSize;
      this.onError = undefined;
    } else {
      this.bufferSize = optionsOrBufferSize?.bufferSize ?? DEFAULT_BUFFER_SIZE;
      this.onError = optionsOrBufferSize?.onError;
    }
    this.buffer = new Array<WorkerEvent>(this.bufferSize);
  }

  /**
   * Returns the number of events dropped due to ring buffer overflow.
   */
  getDroppedCount(): number {
    return this.droppedEventCount;
  }

  /**
   * Subscribe to events on a channel.
   *
   * @param channel - Channel name to subscribe to. Common values:
   *   - A node ID to receive events from a specific node.
   *   - A workflow ID to receive all events from a specific workflow (preferred
   *     over '*' when per-workflow isolation is needed — avoids O(N) fan-out).
   *   - '*' to receive all events (use sparingly; scales linearly with workflows).
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
   * Emit an event to all subscribers on the matching channels.
   *
   * Dispatches to (in order):
   *   1. channel keyed by event.nodeId
   *   2. channel keyed by event.workerId
   *   3. channel keyed by event.workflowId  ← [L1] workflow-scoped routing
   *   4. wildcard '*' channel
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
      this.droppedEventCount++;
    }

    // [L1] Dispatch to channel-specific, workflow-scoped, and wildcard subscribers.
    // Guard: only look up channel if the key is defined (prevents Map.get(undefined)).
    // workflowId routing lets subscribers use subscribe(workflowId, handler) instead
    // of subscribe('*', handler) + manual workflowId filter, cutting fan-out to O(1).
    const targets = [
      event.nodeId !== undefined ? this.channels.get(event.nodeId) : undefined,
      event.workerId !== undefined ? this.channels.get(event.workerId) : undefined,
      event.workflowId !== undefined ? this.channels.get(event.workflowId) : undefined,
      this.channels.get('*'),
    ];

    for (const handlers of targets) {
      if (handlers) {
        for (const handler of handlers) {
          try {
            const result = handler(event);
            // Fire-and-forget for async handlers — route errors to onError
            if (result && typeof (result as Promise<void>).catch === 'function') {
              (result as Promise<void>).catch((err) => {
                this.handleError(err, event);
              });
            }
          } catch (err) {
            this.handleError(err, event);
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
            (result as Promise<void>).catch((err) => {
              this.handleError(err, event);
            });
          }
        } catch (err) {
          this.handleError(err, event);
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
   *
   * Note: pending batched events in throttled subscriptions are dropped.
   * Do not call clear() while active workflows are running unless a hard
   * reset is intended (e.g. session teardown).
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

  /**
   * Route a handler error to the onError callback or console.error.
   */
  private handleError(err: unknown, event: WorkerEvent): void {
    if (this.onError) {
      try {
        this.onError(err, event.type, event);
      } catch {
        // Prevent onError itself from crashing the emitter
        console.error('[EventBus] onError callback threw:', err);
      }
    } else {
      console.error('[EventBus] handler error:', err);
    }
  }
}
