import { create } from 'zustand';
export const useChatStore = create((set) => ({
    messages: [],
    isStreaming: false,
    thinkingContent: '',
    addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
    appendToLast: (content) => set((s) => {
        const msgs = [...s.messages];
        if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
            msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: msgs[msgs.length - 1].content + content,
            };
        }
        else {
            msgs.push({
                id: crypto.randomUUID(),
                role: 'assistant',
                content,
                timestamp: new Date().toISOString(),
            });
        }
        return { messages: msgs };
    }),
    setStreaming: (isStreaming) => set({ isStreaming }),
    setThinking: (thinkingContent) => set({ thinkingContent }),
    appendThinking: (t) => set((s) => ({ thinkingContent: s.thinkingContent + t })),
}));
//# sourceMappingURL=chat.js.map