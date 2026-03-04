/** Configuration for creating a new memory bank. */
export interface BankConfig {
  /** Human-readable name for the bank. */
  name: string;
  /** How aggressively the bank filters low-confidence memories (1–5). */
  skepticism?: number;
  /** How literally queries are interpreted vs. semantic expansion (1–5). */
  literalism?: number;
  /** How much emotional/relational context is weighted in recall (1–5). */
  empathy?: number;
}

/** Summary information about a memory bank. */
export interface BankInfo {
  id: string;
  name: string;
  created_at: string;
  memory_count: number;
}

/** A single memory item to retain. */
export interface MemoryItem {
  /** The memory content text. */
  content: string;
  /** Category: preference, decision, lesson, project_update, infrastructure, architecture, codebase, relationship, session_summary. */
  context: string;
  /** ISO 8601 timestamp for when this memory was formed. */
  timestamp: string;
}

/** Result of a retain (store) operation. */
export interface RetainResult {
  success: boolean;
  bank_id: string;
  items_count: number;
}

/** Options for memory recall queries. */
export interface RecallOptions {
  /** Maximum tokens to return (default: 4096). */
  maxTokens?: number;
  /** Search depth budget (default: 'mid'). */
  budget?: 'low' | 'mid' | 'high';
}

/** A single recalled memory with relevance score. */
export interface RecalledMemory {
  content: string;
  context: string;
  timestamp: string;
  /** Relevance score (0–1) indicating match quality. */
  relevance: number;
}

/** Result of a recall (query) operation. */
export interface RecallResult {
  memories: RecalledMemory[];
  tokens_used: number;
}

/** A pre-synthesized mental model derived from stored memories. */
export interface MentalModel {
  id: string;
  content: string;
  last_refreshed: string;
  source_count: number;
}

/** Health check response from the Hindsight API. */
export interface HealthStatus {
  status: 'ok' | 'error';
  version?: string;
}
