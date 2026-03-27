import { create } from 'zustand';

interface ConnectionStore {
  gatewayConnected: boolean;
  hindsightConnected: boolean;
  hindsightBusy: boolean;
  setGatewayConnected: (v: boolean) => void;
  setHindsightStatus: (connected: boolean, busy: boolean) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  gatewayConnected: false,
  hindsightConnected: false,
  hindsightBusy: false,
  setGatewayConnected: (gatewayConnected) => set({ gatewayConnected }),
  setHindsightStatus: (hindsightConnected, hindsightBusy) =>
    set({ hindsightConnected, hindsightBusy }),
}));
