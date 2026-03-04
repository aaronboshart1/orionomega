/**
 * @module events
 * Event streaming to connected clients with mode-aware batching.
 *
 * - **web** clients receive every event immediately.
 * - **tui** clients receive batched events on an interval, except for
 *   high-priority types (done, error, finding) which fire immediately.
 */

import type { WebSocket } from 'ws';
import type { ClientConnection, ServerMessage } from './types.js';
import { randomBytes } from 'node:crypto';

/** Event types that bypass batching and fire immediately for TUI clients. */
const IMMEDIATE_TYPES = new Set(['done', 'error', 'finding']);

/** Default batch interval for TUI clients (milliseconds). */
const TUI_BATCH_INTERVAL_MS = 10_000;

/** Interval for periodic graph-state snapshots during active workflows (milliseconds). */
const GRAPH_SNAPSHOT_INTERVAL_MS = 5_000;

interface QueuedEvent {
  event: unknown;
  eventType?: string;
}

/**
 * Manages event delivery to connected gateway clients.
 * Supports both immediate (web) and batched (tui) delivery modes.
 */
export class EventStreamer {
  private clients: Map<string, ClientConnection> = new Map();
  private tuiBatches: Map<string, QueuedEvent[]> = new Map();
  private batchTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private graphStateProvider: (() => unknown) | null = null;

  /**
   * Register a client connection for event delivery.
   * @param client - The client connection to register.
   */
  addClient(client: ClientConnection): void {
    this.clients.set(client.id, client);

    if (client.eventMode === 'throttled' || client.clientType === 'tui') {
      this.tuiBatches.set(client.id, []);
      const timer = setInterval(() => this.flushBatch(client.id), TUI_BATCH_INTERVAL_MS);
      this.batchTimers.set(client.id, timer);
    }
  }

  /**
   * Unregister a client connection and clean up timers.
   * @param clientId - The client ID to remove.
   */
  removeClient(clientId: string): void {
    this.clients.delete(clientId);
    this.tuiBatches.delete(clientId);

    const timer = this.batchTimers.get(clientId);
    if (timer) {
      clearInterval(timer);
      this.batchTimers.delete(clientId);
    }

    // Stop snapshot timer if no clients remain
    if (this.clients.size === 0) {
      this.stopGraphSnapshots();
    }
  }

  /**
   * Set a provider function for graph-state snapshots.
   * @param provider - A function returning the current graph state.
   */
  setGraphStateProvider(provider: () => unknown): void {
    this.graphStateProvider = provider;
  }

  /**
   * Start sending periodic graph-state snapshots to all connected clients.
   */
  startGraphSnapshots(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setInterval(() => {
      if (!this.graphStateProvider) return;
      const state = this.graphStateProvider();
      this.broadcast({
        id: randomBytes(8).toString('hex'),
        type: 'event',
        graphState: state,
      });
    }, GRAPH_SNAPSHOT_INTERVAL_MS);
  }

  /**
   * Stop periodic graph-state snapshots.
   */
  stopGraphSnapshots(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  /**
   * Emit an event to all connected clients, respecting delivery modes.
   * @param event - The raw event payload.
   * @param eventType - Optional event type string (e.g. 'done', 'error', 'finding').
   */
  emit(event: unknown, eventType?: string): void {
    for (const [clientId, client] of this.clients) {
      if (client.clientType === 'web' || client.eventMode === 'full') {
        this.sendToClient(client, {
          id: randomBytes(8).toString('hex'),
          type: 'event',
          event,
        });
      } else {
        // TUI / throttled mode
        if (eventType && IMMEDIATE_TYPES.has(eventType)) {
          this.sendToClient(client, {
            id: randomBytes(8).toString('hex'),
            type: 'event',
            event,
          });
        } else {
          const batch = this.tuiBatches.get(clientId);
          if (batch) {
            batch.push({ event, eventType });
          }
        }
      }
    }
  }

  /**
   * Send a server message to all connected clients.
   * @param message - The server message to broadcast.
   */
  broadcast(message: ServerMessage): void {
    for (const client of this.clients.values()) {
      this.sendToClient(client, message);
    }
  }

  /**
   * Clean up all timers and state.
   */
  destroy(): void {
    this.stopGraphSnapshots();
    for (const timer of this.batchTimers.values()) {
      clearInterval(timer);
    }
    this.batchTimers.clear();
    this.tuiBatches.clear();
    this.clients.clear();
  }

  /** Flush the event batch for a TUI client. */
  private flushBatch(clientId: string): void {
    const client = this.clients.get(clientId);
    const batch = this.tuiBatches.get(clientId);
    if (!client || !batch || batch.length === 0) return;

    const events = batch.map((q) => q.event);
    this.tuiBatches.set(clientId, []);

    this.sendToClient(client, {
      id: randomBytes(8).toString('hex'),
      type: 'event',
      event: events,
    });
  }

  /** Safely send JSON to a WebSocket client. */
  private sendToClient(client: ClientConnection, message: ServerMessage): void {
    try {
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    } catch (err) {
      console.error(`[gateway] Failed to send to client ${client.id}:`, err);
    }
  }
}
