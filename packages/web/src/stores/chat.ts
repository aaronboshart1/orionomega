import { create } from 'zustand';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  type?:
    | 'text'
    | 'plan'
    | 'orchestration-update'
    | 'command-result'
    | 'dag-dispatched'
    | 'dag-progress'
    | 'dag-complete'
    | 'dag-confirmation';
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

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  isStreaming: false,
  thinkingContent: '',
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  appendToLast: (content) =>
    set((s) => {
      const msgs = [...s.messages];
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
        msgs[msgs.length - 1] = {
          ...msgs[msgs.length - 1],
          content: msgs[msgs.length - 1].content + content,
        };
      } else {
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
