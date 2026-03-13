export declare function useGateway(url?: string): {
    send: (data: object) => void;
    sendChat: (content: string) => void;
    sendCommand: (command: string) => void;
    respondToPlan: (planId: string, action: string, modification?: string) => void;
    respondToDAG: (workflowId: string, action: "approve" | "reject") => void;
    respondToConfirmation: (dagId: string, approved: boolean) => void;
};
//# sourceMappingURL=gateway.d.ts.map