import { describe, it, expect } from 'vitest';
import { truncate } from '../truncate.js';

describe('truncate', () => {
  it('returns the input unchanged when within the limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('exact', 5)).toBe('exact');
    expect(truncate('', 0)).toBe('');
  });

  it('truncates oversized strings and records the original length', () => {
    const input = 'a'.repeat(600);
    const out = truncate(input, 500);
    expect(out).toBe('a'.repeat(500) + '... [truncated, 600 chars]');
  });

  it('uses the original length (not the truncated length) in the marker', () => {
    const out = truncate('x'.repeat(1234), 500);
    expect(out.endsWith('... [truncated, 1234 chars]')).toBe(true);
    // 500 kept chars + marker
    expect(out.startsWith('x'.repeat(500))).toBe(true);
  });
});
