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
  interrupted?: boolean;
}

interface ChatStore {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingStatus: string;
  thinkingContent: string;
  addMessage: (msg: ChatMessage) => void;
  setMessages: (msgs: ChatMessage[]) => void;
  appendToLast: (content: string) => void;
  setStreaming: (s: boolean) => void;
  setStreamingStatus: (status: string) => void;
  setThinking: (t: string) => void;
  appendThinking: (t: string) => void;
  markLastInterrupted: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  isStreaming: false,
  streamingStatus: '',
  thinkingContent: '',
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  setMessages: (messages) => set({ messages }),
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
  setStreamingStatus: (streamingStatus) => set({ streamingStatus }),
  setThinking: (thinkingContent) => set({ thinkingContent }),
  appendThinking: (t) => set((s) => ({ thinkingContent: s.thinkingContent + t })),
  markLastInterrupted: () =>
    set((s) => {
      const msgs = [...s.messages];
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], interrupted: true };
        return { messages: msgs, isStreaming: false };
      }
      return { isStreaming: false };
    }),
}));
