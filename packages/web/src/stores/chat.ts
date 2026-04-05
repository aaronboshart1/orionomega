import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useEffect, useState } from 'react';
import { uuid } from '@/lib/uuid';

export interface ThinkingStep {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'done';
  startedAt?: number;
  completedAt?: number;
  elapsedMs?: number;
  detail?: string;
}

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

export interface ReplyToData {
  messageId: string;
  content: string;
  role: 'user' | 'assistant' | 'system';
  dagId?: string;
}

export interface MessageAttachment {
  name: string;
  size: number;
  type: string;
  dataUrl?: string;
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
    | 'direct-complete'
    | 'dag-confirmation'
    | 'tool-call'
    | 'error';
  dagId?: string;
  workflowId?: string;
  isBackground?: boolean;
  toolCall?: ToolCallData;
  interrupted?: boolean;
  replyTo?: ReplyToData;
  attachments?: MessageAttachment[];
}

interface ChatStore {
  messages: ChatMessage[];
  isStreaming: boolean;
  thinkingContent: string;
  streamingStatus: string;
  thinkingSteps: ThinkingStep[];
  replyTarget: ReplyToData | null;
  addMessage: (msg: ChatMessage) => void;
  setMessages: (msgs: ChatMessage[]) => void;
  appendToLast: (content: string, messageId?: string) => void;
  appendToBackground: (workflowId: string, content: string, messageId?: string) => void;
  setStreaming: (s: boolean) => void;
  setThinking: (t: string) => void;
  appendThinking: (t: string) => void;
  upsertThinkingStep: (step: ThinkingStep) => void;
  clearThinkingSteps: () => void;
  updateToolCallStatus: (messageId: string, status: 'running' | 'done' | 'error') => void;
  setStreamingStatus: (status: string) => void;
  markLastInterrupted: () => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  clearMessages: () => void;
  setReplyTarget: (target: ReplyToData | null) => void;
}

/** Max messages to persist to localStorage to prevent quota exhaustion. */
const MAX_PERSISTED_MESSAGES = 50;

/**
 * Safe localStorage adapter that catches QuotaExceededError.
 * On quota failure: clears the key and retries once. If still failing, silently drops.
 */
const safeLocalStorage = {
  getItem(name: string): string | null {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name: string, value: string): void {
    try {
      localStorage.setItem(name, value);
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) {
        try {
          localStorage.removeItem(name);
          localStorage.setItem(name, value);
        } catch {
          // Still failing — silently drop the write
        }
      }
    }
  },
  removeItem(name: string): void {
    try {
      localStorage.removeItem(name);
    } catch {
      // ignore
    }
  },
};

export const useChatStore = create<ChatStore>()(
  persist(
    (set) => ({
      messages: [],
      isStreaming: false,
      thinkingContent: '',
      streamingStatus: '',
      thinkingSteps: [],
      replyTarget: null,
      addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
      setMessages: (messages) => set({ messages }),
      appendToLast: (content, messageId) =>
        set((s) => {
          const msgs = [...s.messages];
          const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          if (last && last.role === 'assistant' && !last.isBackground) {
            msgs[msgs.length - 1] = {
              ...last,
              content: last.content + content,
            };
          } else {
            msgs.push({
              id: messageId || uuid(),
              role: 'assistant',
              content,
              timestamp: new Date().toISOString(),
            });
          }
          return { messages: msgs };
        }),
      appendToBackground: (workflowId, content, messageId) =>
        set((s) => {
          const msgs = [...s.messages];
          let idx = -1;
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant' && msgs[i].workflowId === workflowId) {
              idx = i;
              break;
            }
          }
          if (idx >= 0) {
            msgs[idx] = { ...msgs[idx], content: msgs[idx].content + content };
          } else {
            msgs.push({
              id: messageId || uuid(),
              role: 'assistant',
              content,
              timestamp: new Date().toISOString(),
              workflowId,
              isBackground: true,
            });
          }
          return { messages: msgs };
        }),
      setStreaming: (isStreaming) =>
        set(isStreaming ? { isStreaming } : { isStreaming, streamingStatus: '' }),
      setThinking: (thinkingContent) => set({ thinkingContent }),
      appendThinking: (t) => set((s) => ({ thinkingContent: s.thinkingContent + t })),
      upsertThinkingStep: (step) =>
        set((s) => {
          const idx = s.thinkingSteps.findIndex((ts) => ts.id === step.id);
          if (idx >= 0) {
            const updated = [...s.thinkingSteps];
            updated[idx] = step;
            return { thinkingSteps: updated };
          }
          return { thinkingSteps: [...s.thinkingSteps, step] };
        }),
      clearThinkingSteps: () => set({ thinkingSteps: [] }),
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
          return { messages: msgs, isStreaming: false, streamingStatus: '', thinkingContent: '', thinkingSteps: [] };
        }),
      updateMessage: (id, updates) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
        })),
      clearMessages: () => set({ messages: [] }),
      setReplyTarget: (replyTarget) => set({ replyTarget }),
    }),
    {
      name: 'orionomega-chat',
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({
        messages: state.messages.slice(-MAX_PERSISTED_MESSAGES).map((m) => {
          // Strip dataUrl from attachments to avoid persisting large base64 blobs
          if (m.attachments?.some((a) => a.dataUrl)) {
            return {
              ...m,
              attachments: m.attachments.map(({ dataUrl: _dataUrl, ...rest }) => rest),
            };
          }
          return m;
        }),
      }),
    },
  ),
);

export function useChatHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const unsub = useChatStore.persist.onFinishHydration(() => setHydrated(true));
    if (useChatStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);
  return hydrated;
}
