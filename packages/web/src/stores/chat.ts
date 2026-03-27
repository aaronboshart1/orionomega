import { create } from 'zustand';

export interface ToolCallData {
  toolName: string;
  action?: string;
  file?: string;
  summary: string;
  status: 'running' | 'done' | 'error';
  workerId?: string;
  nodeId?: string;
  nodeLabel?: string;
}

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
    | 'dag-confirmation'
    | 'tool-call'
    | 'error';
  dagId?: string;
  toolCall?: ToolCallData;
  interrupted?: boolean;
}

interface ChatStore {
  messages: ChatMessage[];
  isStreaming: boolean;
  thinkingContent: string;
  streamingStatus: string;
  addMessage: (msg: ChatMessage) => void;
  setMessages: (msgs: ChatMessage[]) => void;
  appendToLast: (content: string) => void;
  setStreaming: (s: boolean) => void;
  setThinking: (t: string) => void;
  appendThinking: (t: string) => void;
  updateToolCallStatus: (messageId: string, status: 'running' | 'done' | 'error') => void;
  setStreamingStatus: (status: string) => void;
  markLastInterrupted: () => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  isStreaming: false,
  thinkingContent: '',
  streamingStatus: '',
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
  setStreaming: (isStreaming) =>
    set(isStreaming ? { isStreaming } : { isStreaming, streamingStatus: '' }),
  setThinking: (thinkingContent) => set({ thinkingContent }),
  appendThinking: (t) => set((s) => ({ thinkingContent: s.thinkingContent + t })),
  updateToolCallStatus: (messageId, status) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId && m.toolCall
          ? { ...m, toolCall: { ...m.toolCall, status } }
          : m,
      ),
    })),
  setStreamingStatus: (streamingStatus) => set({ streamingStatus }),
  markLastInterrupted: () =>
    set((s) => {
      if (!s.isStreaming) return s;
      const msgs = [...s.messages];
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
        msgs[msgs.length - 1] = {
          ...msgs[msgs.length - 1],
          interrupted: true,
        };
      }
      return { messages: msgs, isStreaming: false, streamingStatus: '', thinkingContent: '' };
    }),
  updateMessage: (id, updates) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    })),
}));
