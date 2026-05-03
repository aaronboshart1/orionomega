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
  /**
   * Stable correlation ID from the underlying Anthropic tool_use block.
   * When present, gateway/web uses it to pair tool_call ↔ tool_result
   * deterministically — heuristic matching on (name, file, status) can
   * mis-merge repeated calls (e.g. two `read_file` calls in one turn).
   */
  toolCallId?: string;
  /** Truncated tool input params for the expanded view (Direct mode tool transparency). */
  params?: Record<string, unknown>;
  /** Truncated tool result preview shown when the card is expanded. */
  result?: string;
  /** Set when the tool returned an error so the card can render in an error style. */
  isError?: boolean;
  /** Wall-clock duration in milliseconds, populated on tool_result. */
  durationMs?: number;
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
  /** Server-assigned sequence number (used for pagination/gap recovery). */
  seq?: number;
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
    | 'gate-request'
    | 'tool-call'
    | 'error';
  dagId?: string;
  workflowId?: string;
  isBackground?: boolean;
  toolCall?: ToolCallData;
  interrupted?: boolean;
  feedback?: 'good' | 'bad' | null;
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
  prependMessages: (msgs: ChatMessage[]) => void;
  appendToLast: (content: string, messageId?: string) => void;
  appendToBackground: (workflowId: string, content: string, messageId?: string) => void;
  setStreaming: (s: boolean) => void;
  setThinking: (t: string) => void;
  appendThinking: (t: string) => void;
  upsertThinkingStep: (step: ThinkingStep) => void;
  clearThinkingSteps: () => void;
  markThinkingStepsDone: () => void;
  updateToolCallStatus: (messageId: string, status: 'running' | 'done' | 'error') => void;
  updateToolCall: (messageId: string, updates: Partial<ToolCallData>) => void;
  /**
   * Remove the message with `messageId` and every message after it.
   * Returns the removed slice (the target message is included in the
   * returned array so callers can re-send / inspect it).
   */
  truncateAfter: (messageId: string) => ChatMessage[];
  setStreamingStatus: (status: string) => void;
  markLastInterrupted: () => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  clearMessages: () => void;
  setReplyTarget: (target: ReplyToData | null) => void;
  /** Pre-fill the composer with this text on the next render. ChatInput consumes and clears it. */
  draftInput: string | null;
  setDraftInput: (text: string | null) => void;
  setMessageFeedback: (id: string, feedback: 'good' | 'bad' | null) => void;
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
      prependMessages: (msgs) =>
        set((s) => {
          const existingIds = new Set(s.messages.map((m) => m.id));
          const newMsgs = msgs.filter((m) => !existingIds.has(m.id));
          if (newMsgs.length === 0) return s;
          return { messages: [...newMsgs, ...s.messages] };
        }),
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
      markThinkingStepsDone: () =>
        set((s) => ({
          thinkingSteps: s.thinkingSteps.map((step) => ({ ...step, status: 'done' as const })),
        })),
      updateToolCallStatus: (messageId, status) =>
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === messageId && m.toolCall
              ? { ...m, toolCall: { ...m.toolCall, status } }
              : m,
          ),
        })),
      updateToolCall: (messageId, updates) =>
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === messageId && m.toolCall
              ? { ...m, toolCall: { ...m.toolCall, ...updates } }
              : m,
          ),
        })),
      truncateAfter: (messageId) => {
        let removed: ChatMessage[] = [];
        set((s) => {
          const idx = s.messages.findIndex((m) => m.id === messageId);
          if (idx < 0) return s;
          removed = s.messages.slice(idx);
          return { messages: s.messages.slice(0, idx) };
        });
        return removed;
      },
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
      draftInput: null,
      setDraftInput: (draftInput) => set({ draftInput }),
      setMessageFeedback: (id, feedback) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, feedback } : m)),
        })),
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
