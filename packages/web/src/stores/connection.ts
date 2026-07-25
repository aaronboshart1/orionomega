import { create } from 'zustand';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

/**
 * Stale-build status reported by the gateway's `/api/status` endpoint.
 * When `isStale` is true, the web UI shows a small "rebuild required"
 * indicator next to the version label so the user can immediately tell
 * that the gateway dist/ doesn't match the source tree on disk.
 */
export interface StaleBuildInfo {
  isStale: boolean;
  reason: string;
  builtDirty: boolean;
  gatewayShortCommit?: string;
  coreShortCommit?: string;
  sourceShortCommit?: string | null;
}

/**
 * What the memory store can currently do. Never a connectivity flag — the UI
 * reports capability, so it never renders "offline".
 */
export type MemoryHealth = 'ready' | 'rebuilding' | 'degraded';

export interface MemoryActivity {
  busy: boolean;
  health: MemoryHealth;
  /** Rebuild progress 0-100, present while `health === 'rebuilding'`. */
  pct?: number;
  reason?: 'redis_unreachable' | 'index_cold' | 'write_failed';
  /** Current operation label, e.g. `recall` / `retain`. */
  op?: string;
  /** Records touched by the current operation. */
  count?: number;
}

interface ConnectionStore {
  gatewayConnected: boolean;
  /**
   * Latest memory activity. Before the store's first report the index has not
   * been built, so the honest default is `rebuilding / index_cold`.
   */
  memoryActivity: MemoryActivity;
  /** Tri-state connection status for the UI indicator. */
  connectionStatus: ConnectionStatus;
  /** Current reconnection attempt count (reset on successful connect). */
  reconnectAttempt: number;
  /** Session ID assigned by the server. */
  sessionId: string | null;
  /** Total number of times the client has reconnected in this browser session. */
  reconnectCount: number;
  /** Last event sequence number received from the server. */
  lastSeenSeq: number;
  /** Number of active viewers in the current session (presence). */
  presenceCount: number;
  /** Whether the server has older messages not yet loaded by the client. */
  hasOlderMessages: boolean;
  /** Stale-build status for the gateway dist/ vs source tree. */
  staleBuild: StaleBuildInfo | null;
  setGatewayConnected: (connected: boolean) => void;
  setMemoryActivity: (activity: MemoryActivity) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setReconnectAttempt: (attempt: number) => void;
  setSessionId: (id: string) => void;
  setLastSeenSeq: (seq: number) => void;
  setPresenceCount: (n: number) => void;
  setHasOlderMessages: (has: boolean) => void;
  setStaleBuild: (info: StaleBuildInfo | null) => void;
  /** Mark the connection as disconnected and increment reconnect tracking. */
  markDisconnected: () => void;
  /** Mark the connection as successfully reconnected. */
  markReconnected: () => void;
}

export const useConnectionStore = create<ConnectionStore>()((set) => ({
  gatewayConnected: false,
  memoryActivity: { busy: false, health: 'rebuilding', reason: 'index_cold' },
  connectionStatus: 'disconnected',
  reconnectAttempt: 0,
  sessionId: null,
  reconnectCount: 0,
  lastSeenSeq: 0,
  presenceCount: 0,
  hasOlderMessages: false,
  staleBuild: null,
  setGatewayConnected: (gatewayConnected) => set({ gatewayConnected }),
  setMemoryActivity: (memoryActivity) => set({ memoryActivity }),
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setReconnectAttempt: (reconnectAttempt) => set({ reconnectAttempt }),
  setSessionId: (sessionId) => set({ sessionId }),
  setLastSeenSeq: (lastSeenSeq) => set({ lastSeenSeq }),
  setPresenceCount: (presenceCount) => set({ presenceCount }),
  setHasOlderMessages: (hasOlderMessages) => set({ hasOlderMessages }),
  setStaleBuild: (staleBuild) => set({ staleBuild }),
  markDisconnected: () =>
    set((s) => ({
      gatewayConnected: false,
      connectionStatus: 'reconnecting',
      reconnectAttempt: s.reconnectAttempt + 1,
    })),
  markReconnected: () =>
    set((s) => ({
      gatewayConnected: true,
      connectionStatus: 'connected',
      reconnectAttempt: 0,
      reconnectCount: s.reconnectCount + 1,
    })),
}));
