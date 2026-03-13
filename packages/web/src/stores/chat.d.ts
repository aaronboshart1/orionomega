export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    type?: 'text' | 'plan' | 'orchestration-update' | 'command-result' | 'dag-dispatched' | 'dag-progress' | 'dag-complete' | 'dag-confirmation';
    dagId?: string;
}
interface ChatStore {
    messages: ChatMessage[];
    isStreaming: boolean;
    thinkingContent: string;
    addMessage: (msg: ChatMessage) => void;
    appendToLast: (content: string) => void;
    setStreaming: (s: boolean) => void;
    setThinking: (t: string) => void;
    appendThinking: (t: string) => void;
}
export declare const useChatStore: import("zustand").UseBoundStore<import("zustand").StoreApi<ChatStore>>;
export {};
//# sourceMappingURL=chat.d.ts.map