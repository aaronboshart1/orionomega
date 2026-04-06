import { create } from 'zustand';
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

export interface MessageMetadata {
  /** Model used for this response */
  model?: string;
  /** Input tokens consumed */
  inputTokens?: number;
  /** Output tokens generated */
  outputTokens?: number;
  /** Cache read tokens */
  cacheReadTokens?: number;
  /** Cost in USD for this message */
  costUsd?: number;
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
  /** Per-message token/cost metadata */
  metadata?: MessageMetadata;
}

/** Cumulative session-level token/cost totals */
export interface SessionTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number;
  messageCount: number;
}

interface ChatStore {
  messages: ChatMessage[];
  isStreaming: boolean;
  thinkingContent: string;
  streamingStatus: string;
  thinkingSteps: ThinkingStep[];
  replyTarget: ReplyToData | null;
  sessionTotals: SessionTokenTotals;
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
  accumulateTokens: (meta: MessageMetadata) => void;
  /** Rehydrate store from a server state snapshot (replaces localStorage persistence). */
  hydrateFromSnapshot: (snapshot: { messages?: ChatMessage[]; sessionTotals?: SessionTokenTotals }) => void;
}

export const useChatStore = create<ChatStore>()((set) => ({
      messages: [],
      isStreaming: false,
      thinkingContent: '',
      streamingStatus: '',
      thinkingSteps: [],
      replyTarget: null,
      sessionTotals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, messageCount: 0 },
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
      clearMessages: () => set({ messages: [], sessionTotals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, messageCount: 0 } }),
      setReplyTarget: (replyTarget) => set({ replyTarget }),
      accumulateTokens: (meta) =>
        set((s) => ({
          sessionTotals: {
            inputTokens: s.sessionTotals.inputTokens + (meta.inputTokens ?? 0),
            outputTokens: s.sessionTotals.outputTokens + (meta.outputTokens ?? 0),
            cacheReadTokens: s.sessionTotals.cacheReadTokens + (meta.cacheReadTokens ?? 0),
            totalCostUsd: s.sessionTotals.totalCostUsd + (meta.costUsd ?? 0),
            messageCount: s.sessionTotals.messageCount + 1,
          },
        })),
      /**
       * Rehydrate from a server state snapshot with error resilience.
       * If the snapshot data is malformed, falls back to safe defaults.
       */
      hydrateFromSnapshot: (snapshot) => {
        try {
          const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
          const totals = snapshot.sessionTotals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, messageCount: 0 };
          set({
            messages,
            sessionTotals: {
              inputTokens: typeof totals.inputTokens === 'number' ? totals.inputTokens : 0,
              outputTokens: typeof totals.outputTokens === 'number' ? totals.outputTokens : 0,
              cacheReadTokens: typeof totals.cacheReadTokens === 'number' ? totals.cacheReadTokens : 0,
              totalCostUsd: typeof totals.totalCostUsd === 'number' ? totals.totalCostUsd : 0,
              messageCount: typeof totals.messageCount === 'number' ? totals.messageCount : 0,
            },
            isStreaming: false,
            thinkingContent: '',
            streamingStatus: '',
            thinkingSteps: [],
          });
        } catch {
          // Graceful degradation: reset to empty state on corrupt snapshot
          set({
            messages: [],
            sessionTotals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, messageCount: 0 },
            isStreaming: false,
            thinkingContent: '',
            streamingStatus: '',
            thinkingSteps: [],
          });
        }
      },
}));

export function useChatHydrated(): boolean {
  return true;
}
