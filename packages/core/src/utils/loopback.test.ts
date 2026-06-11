import { describe, it, expect } from 'vitest';
import { isLoopbackHost, isValidPort, assertLoopbackTarget } from './loopback.js';

describe('isLoopbackHost', () => {
  it('accepts localhost', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
  });

  it('accepts the 127.0.0.0/8 range', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
  });

  it('accepts IPv6 loopback forms', () => {
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects non-loopback hosts', () => {
    expect(isLoopbackHost('169.254.169.254')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('isValidPort', () => {
  it('accepts in-range ports', () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(9877)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  it('rejects out-of-range / non-integer ports', () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(3.5)).toBe(false);
    expect(isValidPort(NaN)).toBe(false);
  });
});

describe('assertLoopbackTarget', () => {
  it('passes for valid loopback target', () => {
    expect(() => assertLoopbackTarget('127.0.0.1', 9877)).not.toThrow();
  });

  it('throws for non-loopback host', () => {
    expect(() => assertLoopbackTarget('169.254.169.254', 80)).toThrow(/non-loopback/i);
  });

  it('throws for invalid port', () => {
    expect(() => assertLoopbackTarget('127.0.0.1', 0)).toThrow(/port/i);
  });
});
