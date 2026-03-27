import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Tool-call data shape (matches gateway tool_call events)
// ---------------------------------------------------------------------------
export interface ToolCall {
  /** Unique ID for this tool invocation */
  id: string;
  /** Tool / function name */
  name: string;
  /** Lifecycle status */
  status: 'pending' | 'running' | 'done' | 'error';
  /** Raw input arguments (JSON-serialisable) */
  input?: unknown;
  /** Tool output / result */
  output?: unknown;
  /** Error message if status === 'error' */
  error?: string;
}

// ---------------------------------------------------------------------------
// File attachment metadata (display only — raw data is not stored in the store)
// ---------------------------------------------------------------------------
export interface FileAttachment {
  name: string;
  size: number;
  type: string;
}

// ---------------------------------------------------------------------------
// Chat message
// ---------------------------------------------------------------------------
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
    | 'tool-call';
  dagId?: string;
  /** Populated when type === 'tool-call' */
  toolCall?: ToolCall;
  /** File attachments sent with this message (user messages only) */
  attachments?: FileAttachment[];
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
interface ChatStore {
  messages: ChatMessage[];
  isStreaming: boolean;
  thinkingContent: string;
  addMessage: (msg: ChatMessage) => void;
  appendToLast: (content: string) => void;
  setStreaming: (s: boolean) => void;
  setThinking: (t: string) => void;
  appendThinking: (t: string) => void;
  /** Update an existing tool-call message by toolCall.id */
  updateToolCall: (toolCallId: string, patch: Partial<ToolCall>) => void;
  clearMessages: () => void;
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

  updateToolCall: (toolCallId, patch) =>
    set((s) => ({
      messages: s.messages.map((msg) => {
        if (msg.type === 'tool-call' && msg.toolCall?.id === toolCallId) {
          return {
            ...msg,
            toolCall: { ...msg.toolCall, ...patch },
          };
        }
        return msg;
      }),
    })),

  clearMessages: () => set({ messages: [], thinkingContent: '', isStreaming: false }),
}));
