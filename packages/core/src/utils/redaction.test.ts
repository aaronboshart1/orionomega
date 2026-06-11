import { describe, it, expect } from 'vitest';
import { redactSensitive, redactString, REDACTED } from './redaction.js';

describe('redactString', () => {
  it('redacts Anthropic keys', () => {
    expect(redactString('key sk-ant-abc123DEF456ghi here')).toBe(`key ${REDACTED} here`);
  });

  it('redacts Bearer tokens', () => {
    expect(redactString('Authorization: Bearer abcdef123456ghijkl')).toContain(REDACTED);
  });

  it('redacts AWS access key ids', () => {
    expect(redactString('AKIAIOSFODNN7EXAMPLE')).toBe(REDACTED);
  });

  it('leaves innocuous strings alone', () => {
    expect(redactString('just a normal message')).toBe('just a normal message');
  });
});

describe('redactSensitive', () => {
  it('redacts values under sensitive keys regardless of content', () => {
    const out = redactSensitive({ apiKey: 'plainvalue', name: 'ok' });
    expect(out).toEqual({ apiKey: REDACTED, name: 'ok' });
  });

  it('matches sensitive keys case-insensitively and across separators', () => {
    const out = redactSensitive({ 'API_KEY': 'x', 'access-token': 'y', Password: 'z' });
    expect(out).toEqual({ 'API_KEY': REDACTED, 'access-token': REDACTED, Password: REDACTED });
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactSensitive({
      tool: { input: { secret: 'abc' }, items: [{ token: 't' }, 'sk-ant-abcdefghijkl123'] },
    }) as any;
    expect(out.tool.input.secret).toBe(REDACTED);
    expect(out.tool.items[0].token).toBe(REDACTED);
    expect(out.tool.items[1]).toBe(REDACTED);
  });

  it('does not mutate the input', () => {
    const input = { apiKey: 'keep' };
    redactSensitive(input);
    expect(input.apiKey).toBe('keep');
  });

  it('handles circular references without throwing', () => {
    const obj: any = { name: 'x' };
    obj.self = obj;
    const out = redactSensitive(obj) as any;
    expect(out.name).toBe('x');
    expect(out.self).toBe('[CIRCULAR]');
  });

  it('passes primitives through', () => {
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(true)).toBe(true);
    expect(redactSensitive(null)).toBe(null);
  });
});
