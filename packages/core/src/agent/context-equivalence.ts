/**
 * @module agent/context-equivalence
 * Determines whether a new user message is supplementary context for an
 * active run or a completely new task requiring a fresh run.
 */

import type { AnthropicClient } from '../anthropic/client.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('context-equivalence');

export type ContextRelation = 'SUPPLEMENTARY' | 'NEW_TASK';

const SUPPLEMENTARY_PATTERNS = [
  /^\s*(also|and\s+also|oh\s+and|btw|by\s+the\s+way|additionally|plus)\b/i,
  /^\s*(one\s+more\s+thing|another\s+thing|forgot\s+to\s+mention)\b/i,
  /^\s*(for\s+the|for\s+that|in\s+that|on\s+that|about\s+that|regarding)\b/i,
  /^\s*(make\s+sure|don'?t\s+forget|remember\s+to)\b/i,
  /^\s*(use|include|add)\s+(the|a|an)\s+/i,
  /^\s*(and|&)\s+(use|include|make|change|update)\b/i,
  /^\s*(oh|actually)\s*,?\s*(also|and|can\s+you\s+also)\b/i,
];

const NEW_TASK_PATTERNS = [
  /^\s*(instead|actually\s+let'?s|forget\s+(that|it)|never\s*mind|new\s+task|switch\s+to)\b/i,
  /^\s*(now|next)\s+(I\s+want|I\s+need|let'?s|we\s+should|can\s+you)\b/i,
  /^\s*(completely|totally|something)\s+(different|else|new)\b/i,
  /^\s*(stop|cancel|abort)\s+(that|this|the|current)\b/i,
  /^\s*(start\s+over|from\s+scratch|begin\s+again)\b/i,
];

/**
 * Fast regex-based classification. Returns null if ambiguous.
 */
export function classifyContextRelationFast(
  newMessage: string,
  _activeRunMessage: string,
): ContextRelation | null {
  const trimmed = newMessage.trim();

  // Check explicit supplementary signals
  if (SUPPLEMENTARY_PATTERNS.some(p => p.test(trimmed))) {
    return 'SUPPLEMENTARY';
  }

  // Check explicit new-task signals
  if (NEW_TASK_PATTERNS.some(p => p.test(trimmed))) {
    return 'NEW_TASK';
  }

  // Short messages (< 30 words) without task verbs are likely supplementary
  const wordCount = trimmed.split(/\s+/).length;
  const TASK_VERBS = /^(build|create|write|generate|implement|develop|fix|deploy|research|investigate|analyze|refactor|rewrite|redesign|migrate)\b/i;
  if (wordCount <= 30 && !TASK_VERBS.test(trimmed)) {
    return 'SUPPLEMENTARY';
  }

  return null; // Ambiguous -- needs LLM classification
}

const CLASSIFY_PROMPT = `You are classifying whether a follow-up message is supplementary context for an active task or a completely new task.

Active task message: "{activeMessage}"
Follow-up message: "{newMessage}"

SUPPLEMENTARY: The follow-up adds details, corrections, preferences, or refinements to the same task the agent is already working on. Examples: adding a design preference, specifying a file to use, clarifying a requirement.
NEW_TASK: The follow-up is about a completely different topic, requires abandoning the current work, or is clearly a new request unrelated to the active task.

Respond with ONLY the word SUPPLEMENTARY or NEW_TASK.`;

/**
 * LLM-based classification for ambiguous cases. Uses the cheap model.
 */
export async function classifyContextRelation(
  client: AnthropicClient,
  cheapModel: string,
  newMessage: string,
  activeRunMessage: string,
): Promise<ContextRelation> {
  try {
    const prompt = CLASSIFY_PROMPT
      .replace('{activeMessage}', activeRunMessage.slice(0, 500))
      .replace('{newMessage}', newMessage.slice(0, 500));

    const response = await client.createMessage({
      model: cheapModel,
      system: prompt,
      messages: [{ role: 'user', content: 'Classify.' }],
      maxTokens: 8,
    });

    const text = response.content?.[0]?.text?.trim().toUpperCase() ?? 'NEW_TASK';
    log.info('Context relation classified', {
      newMessage: newMessage.slice(0, 80),
      activeMessage: activeRunMessage.slice(0, 80),
      result: text,
    });

    if (text === 'SUPPLEMENTARY') return 'SUPPLEMENTARY';
    return 'NEW_TASK';
  } catch (err) {
    log.warn('Context relation classification failed, defaulting to NEW_TASK', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'NEW_TASK';
  }
}
