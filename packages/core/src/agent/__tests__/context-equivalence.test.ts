import { describe, it, expect, vi } from 'vitest';
import { classifyContextRelationFast, classifyContextRelation } from '../context-equivalence.js';
import type { AnthropicClient } from '../../anthropic/client.js';

describe('classifyContextRelationFast', () => {
  describe('SUPPLEMENTARY patterns', () => {
    it.each([
      ['also for the logo use the actual Omega logo', 'build me a website'],
      ['oh and make the header blue', 'create a landing page'],
      ['btw the API key is abc123', 'connect to the payment API'],
      ['by the way, use TypeScript not JavaScript', 'build a CLI tool'],
      ['one more thing - add dark mode', 'build the settings page'],
      ['use the Roboto font please', 'design the homepage'],
      ['and include a footer', 'build the website layout'],
      ['make sure to handle errors', 'implement the API endpoint'],
      ["don't forget to add tests", 'refactor the auth module'],
      ['for that page use a sidebar layout', 'create the dashboard'],
      ['additionally, support mobile', 'build the navigation'],
      ['and also add a loading spinner', 'implement the data fetch'],
      ['plus a dark background', 'style the hero section'],
      ['forgot to mention - the client uses Postgres', 'set up the database'],
      ['regarding the colors, use the brand palette', 'build the design system'],
    ])('classifies "%s" as SUPPLEMENTARY', (newMsg, activeMsg) => {
      expect(classifyContextRelationFast(newMsg, activeMsg)).toBe('SUPPLEMENTARY');
    });
  });

  describe('NEW_TASK patterns', () => {
    it.each([
      ['instead build me a mobile app', 'build me a website'],
      ['forget that, let me think about it', 'create a landing page'],
      ['never mind the website', 'build the homepage'],
      ['actually lets work on the API', 'build the frontend'],
      ['completely different topic - fix the database', 'design the UI'],
      ['start over with a new approach', 'implement the feature'],
      ['stop the current task', 'running deployment'],
      ['cancel that and start fresh', 'writing the report'],
      ['from scratch please', 'generate the boilerplate'],
      ['switch to a different framework', 'implement using React'],
    ])('classifies "%s" as NEW_TASK', (newMsg, activeMsg) => {
      expect(classifyContextRelationFast(newMsg, activeMsg)).toBe('NEW_TASK');
    });
  });

  describe('short message heuristic — returns SUPPLEMENTARY for short messages without task verbs', () => {
    it.each([
      ['please use purple', 'design the color scheme'],
      ['with TypeScript', 'set up the project'],
      ['it should be responsive', 'build the layout'],
      ['keep it simple', 'implement the feature'],
      ['no animations though', 'add transitions to the page'],
      ['the client prefers blue', 'choose the brand colors'],
    ])('classifies short non-task-verb message "%s" as SUPPLEMENTARY', (newMsg, activeMsg) => {
      expect(classifyContextRelationFast(newMsg, activeMsg)).toBe('SUPPLEMENTARY');
    });
  });

  describe('ambiguous cases that return null', () => {
    describe('short messages starting with a task verb', () => {
      it.each([
        ['build a REST API', 'create the backend'],
        ['fix the authentication bug', 'implement login flow'],
        ['implement the payment flow', 'build the checkout page'],
        ['create a new dashboard', 'redesign the UI'],
        ['write unit tests for auth', 'refactor the module'],
        ['deploy the staging environment', 'prepare for release'],
        ['research caching strategies', 'optimize the queries'],
      ])('returns null for task-verb message "%s"', (newMsg, activeMsg) => {
        expect(classifyContextRelationFast(newMsg, activeMsg)).toBeNull();
      });
    });

    describe('long messages (>30 words) without matching patterns', () => {
      it('returns null for a long context message without supplementary signals', () => {
        const longMsg = 'I was thinking about the overall structure of the project and wondering if the current approach to state management is really the best fit given how the requirements have been evolving over the past few weeks';
        expect(classifyContextRelationFast(longMsg, 'build the frontend')).toBeNull();
      });

      it('returns null for a long multi-concern message', () => {
        const longMsg = 'There are a few things I need to consider about the architecture before moving forward, including the scalability requirements, the database design, the API structure, and how we handle authentication across multiple services';
        expect(classifyContextRelationFast(longMsg, 'design the system')).toBeNull();
      });
    });
  });

  describe('edge cases', () => {
    it('returns SUPPLEMENTARY for an empty string', () => {
      expect(classifyContextRelationFast('', 'build me a website')).toBe('SUPPLEMENTARY');
    });

    it('returns SUPPLEMENTARY for a whitespace-only string', () => {
      expect(classifyContextRelationFast('   ', 'build me a website')).toBe('SUPPLEMENTARY');
    });

    it('returns null for a single task verb', () => {
      expect(classifyContextRelationFast('build', 'build me a website')).toBeNull();
    });

    it('ignores the activeRunMessage in the fast path (only newMessage matters)', () => {
      // Same newMessage should produce the same result regardless of activeRunMessage
      const newMsg = 'also add a dark mode toggle';
      expect(classifyContextRelationFast(newMsg, 'build a website')).toBe('SUPPLEMENTARY');
      expect(classifyContextRelationFast(newMsg, 'something completely different')).toBe('SUPPLEMENTARY');
    });

    it('is case-insensitive for pattern matching', () => {
      expect(classifyContextRelationFast('ALSO add a dark theme', 'build the UI')).toBe('SUPPLEMENTARY');
      expect(classifyContextRelationFast('BTW the API key is xyz', 'connect the service')).toBe('SUPPLEMENTARY');
      expect(classifyContextRelationFast('NEVER MIND', 'build the feature')).toBe('NEW_TASK');
      expect(classifyContextRelationFast('INSTEAD do this', 'the original task')).toBe('NEW_TASK');
    });

    it('handles leading whitespace in newMessage', () => {
      expect(classifyContextRelationFast('  also add caching', 'build the API')).toBe('SUPPLEMENTARY');
      expect(classifyContextRelationFast('  never mind', 'build the feature')).toBe('NEW_TASK');
    });

    it('returns SUPPLEMENTARY for a very short one-word message without task verb', () => {
      expect(classifyContextRelationFast('purple', 'choose the colors')).toBe('SUPPLEMENTARY');
    });

    it('returns null for a long message starting with task verb', () => {
      const longMsg = 'build a completely new authentication system with OAuth2, JWT tokens, refresh token rotation, multi-factor authentication support, and integration with Google and GitHub social login providers';
      expect(classifyContextRelationFast(longMsg, 'add user login')).toBeNull();
    });
  });
});

describe('classifyContextRelation (LLM fallback)', () => {
  function makeClient(responseText: string): AnthropicClient {
    return {
      createMessage: vi.fn().mockResolvedValue({
        id: 'msg-test',
        model: 'claude-haiku',
        role: 'assistant',
        content: [{ type: 'text', text: responseText }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    } as unknown as AnthropicClient;
  }

  it('returns SUPPLEMENTARY when the LLM responds with SUPPLEMENTARY', async () => {
    const client = makeClient('SUPPLEMENTARY');
    const result = await classifyContextRelation(
      client,
      'claude-haiku-4-5-20251001',
      'also use dark mode',
      'build the settings page',
    );
    expect(result).toBe('SUPPLEMENTARY');
  });

  it('returns NEW_TASK when the LLM responds with NEW_TASK', async () => {
    const client = makeClient('NEW_TASK');
    const result = await classifyContextRelation(
      client,
      'claude-haiku-4-5-20251001',
      'build a completely different thing',
      'build the settings page',
    );
    expect(result).toBe('NEW_TASK');
  });

  it('returns NEW_TASK when the LLM response is unrecognized', async () => {
    const client = makeClient('MAYBE');
    const result = await classifyContextRelation(
      client,
      'claude-haiku-4-5-20251001',
      'some ambiguous message',
      'build the settings page',
    );
    expect(result).toBe('NEW_TASK');
  });

  it('defaults to NEW_TASK on client error', async () => {
    const client = {
      createMessage: vi.fn().mockRejectedValue(new Error('network error')),
    } as unknown as AnthropicClient;

    const result = await classifyContextRelation(
      client,
      'claude-haiku-4-5-20251001',
      'some message',
      'active message',
    );
    expect(result).toBe('NEW_TASK');
  });

  it('is case-insensitive when parsing the LLM response', async () => {
    const client = makeClient('supplementary');
    const result = await classifyContextRelation(
      client,
      'claude-haiku-4-5-20251001',
      'also add this',
      'build the page',
    );
    expect(result).toBe('SUPPLEMENTARY');
  });

  it('truncates long inputs to 500 chars before sending to the LLM', async () => {
    const client = makeClient('NEW_TASK');
    const longMessage = 'x'.repeat(1000);
    const longActive = 'y'.repeat(1000);

    await classifyContextRelation(client, 'claude-haiku-4-5-20251001', longMessage, longActive);

    const callArgs = (client.createMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.system).not.toContain('x'.repeat(501));
    expect(callArgs.system).not.toContain('y'.repeat(501));
  });
});
