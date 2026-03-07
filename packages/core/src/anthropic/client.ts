/**
 * @module anthropic/client
 * Lightweight Anthropic API client using native fetch. No SDK dependency.
 */

/** A message in the Anthropic conversation format. */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** A content block within a message. */
export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  thinking?: string;
}

/** Tool definition for the Anthropic API. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A server-sent event from the Anthropic streaming API. */
export interface AnthropicStreamEvent {
  type: string;
  [key: string]: unknown;
}

/** Options for creating a message via the Anthropic API. */
export interface CreateMessageOptions {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  thinking?: { type: 'enabled'; budget_tokens: number };
}

/** Token usage statistics from the Anthropic API. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Non-streaming response from the Anthropic API. */
export interface MessageResponse {
  id: string;
  model: string;
  role: 'assistant';
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: TokenUsage;
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

/**
 * Anthropic API client using native fetch.
 * Handles retries with exponential backoff for rate limits (429) and server errors (5xx).
 */
export class AnthropicClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('Anthropic API key is required');
    }
    this.apiKey = apiKey;
  }

  /**
   * Creates a message (non-streaming). Returns the full response.
   *
   * @param options - Message creation options.
   * @returns The complete message response.
   */
  async createMessage(options: CreateMessageOptions): Promise<MessageResponse> {
    const body = this.buildRequestBody(options, false);

    const response = await this.fetchWithRetry(body);
    const data = await response.json();

    if (!response.ok) {
      const errorMsg = (data as Record<string, unknown>)?.error
        ? JSON.stringify((data as Record<string, unknown>).error)
        : response.statusText;
      throw new Error(
        `Anthropic API error (${response.status}): ${errorMsg}`,
      );
    }

    return data as MessageResponse;
  }

  /**
   * Creates a message with streaming. Yields SSE events as they arrive.
   *
   * @param options - Message creation options.
   * @yields AnthropicStreamEvent for each SSE data line.
   */
  async *streamMessage(
    options: CreateMessageOptions,
  ): AsyncGenerator<AnthropicStreamEvent> {
    const body = this.buildRequestBody(options, true);

    const response = await this.fetchWithRetry(body);

    if (!response.ok) {
      let errorMsg: string;
      try {
        const data = await response.json();
        errorMsg = (data as Record<string, unknown>)?.error
          ? JSON.stringify((data as Record<string, unknown>).error)
          : response.statusText;
      } catch {
        errorMsg = response.statusText;
      }
      throw new Error(
        `Anthropic API error (${response.status}): ${errorMsg}`,
      );
    }

    if (!response.body) {
      throw new Error('Response body is null — streaming not supported');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // comment or empty

          if (trimmed.startsWith('data: ')) {
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') return;

            try {
              const event = JSON.parse(payload) as AnthropicStreamEvent;
              yield event;
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim().startsWith('data: ')) {
        const payload = buffer.trim().slice(6);
        if (payload !== '[DONE]') {
          try {
            yield JSON.parse(payload) as AnthropicStreamEvent;
          } catch {
            // Skip malformed
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Builds the JSON request body for the Anthropic API.
   *
   * Applies prompt caching via `cache_control` breakpoints:
   * - System prompt: cached as ephemeral (stable across all turns)
   * - Last tool definition: cached as ephemeral (tools don't change between turns)
   *
   * This dramatically reduces input token costs in multi-turn agent loops
   * where the system prompt and tools are re-sent on every turn.
   */
  private buildRequestBody(
    options: CreateMessageOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages,
      max_tokens: options.maxTokens ?? 8192,
      stream,
    };

    // System prompt with cache_control for prompt caching
    if (options.system) {
      body.system = [
        {
          type: 'text',
          text: options.system,
          cache_control: { type: 'ephemeral' },
        },
      ];
    }

    // Tools with cache_control on the last tool definition
    if (options.tools && options.tools.length > 0) {
      const tools = options.tools.map((t, i) => {
        if (i === options.tools!.length - 1) {
          // Cache breakpoint on the last tool — caches the entire tools block
          return { ...t, cache_control: { type: 'ephemeral' } };
        }
        return t;
      });
      body.tools = tools;
    }

    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.thinking) body.thinking = options.thinking;

    return body;
  }

  /**
   * Fetches the Anthropic API with retry logic for 429 and 5xx errors.
   */
  private async fetchWithRetry(
    body: Record<string, unknown>,
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': API_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        // Retry on rate limit or server error (but not on last attempt)
        if (
          attempt < MAX_RETRIES &&
          (response.status === 429 || response.status >= 500)
        ) {
          const delay = RETRY_DELAYS[attempt] ?? 4000;
          await this.sleep(delay);
          continue;
        }

        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt] ?? 4000;
          await this.sleep(delay);
        }
      }
    }

    throw lastError ?? new Error('Anthropic API request failed after retries');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
