import { create } from 'zustand';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

interface ConnectionStore {
  gatewayConnected: boolean;
  hindsightConnected: boolean;
  hindsightBusy: boolean;
  /** Tri-state connection status for the UI indicator. */
  connectionStatus: ConnectionStatus;
  /** Current reconnection attempt count (reset on successful connect). */
  reconnectAttempt: number;
  /** Session ID assigned by the server. */
  sessionId: string | null;
  /** Total number of times the client has reconnected in this browser session. */
  reconnectCount: number;
  setGatewayConnected: (connected: boolean) => void;
  setHindsightStatus: (connected: boolean, busy: boolean) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setReconnectAttempt: (attempt: number) => void;
  setSessionId: (id: string) => void;
  /** Mark the connection as disconnected and increment reconnect tracking. */
  markDisconnected: () => void;
  /** Mark the connection as successfully reconnected. */
  markReconnected: () => void;
}

export const useConnectionStore = create<ConnectionStore>()((set) => ({
  gatewayConnected: false,
  hindsightConnected: false,
  hindsightBusy: false,
  connectionStatus: 'disconnected',
  reconnectAttempt: 0,
  sessionId: null,
  reconnectCount: 0,
  setGatewayConnected: (gatewayConnected) => set({ gatewayConnected }),
  setHindsightStatus: (hindsightConnected, hindsightBusy) =>
    set({ hindsightConnected, hindsightBusy }),
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setReconnectAttempt: (reconnectAttempt) => set({ reconnectAttempt }),
  setSessionId: (sessionId) => set({ sessionId }),
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
