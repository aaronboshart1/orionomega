import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  createLogger,
  setGlobalLogLevel,
  getGlobalLogLevel,
  setConsoleLogging,
  setLogTelemetryHook,
  clearLogTelemetryHook,
  truncateValues,
  type LogTelemetryEvent,
} from '../logger.js';

describe('logger', () => {
  beforeEach(() => {
    setGlobalLogLevel('debug');
    setConsoleLogging(true);
  });

  afterEach(() => {
    clearLogTelemetryHook();
    setGlobalLogLevel('info');
    vi.restoreAllMocks();
  });

  it('round-trips the global log level', () => {
    setGlobalLogLevel('verbose');
    expect(getGlobalLogLevel()).toBe('verbose');
  });

  it('suppresses messages above the configured level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setGlobalLogLevel('warn');
    const log = createLogger('test');
    log.info('should not appear');
    log.debug('also not');
    expect(spy).not.toHaveBeenCalled();
    log.warn('should appear');
    log.error('should appear too');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not emit to console when console logging is disabled', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setConsoleLogging(false);
    const log = createLogger('test');
    log.error('hidden');
    expect(spy).not.toHaveBeenCalled();
    setConsoleLogging(true);
  });

  it('fires the telemetry hook only for warn and error', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const events: LogTelemetryEvent[] = [];
    setLogTelemetryHook((e) => events.push(e));
    const log = createLogger('telemetry');
    log.debug('d');
    log.info('i');
    log.verbose('v');
    log.warn('w');
    log.error('e');
    expect(events.map((e) => e.level)).toEqual(['warn', 'error']);
    expect(events[0].name).toBe('telemetry');
  });

  it('never lets a throwing telemetry hook crash the logger', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setLogTelemetryHook(() => {
      throw new Error('boom');
    });
    const log = createLogger('safe');
    expect(() => log.error('still works')).not.toThrow();
  });

  it('truncateValues only shortens strings over 500 chars', () => {
    expect(truncateValues('k', 'short')).toBe('short');
    expect(truncateValues('k', 42)).toBe(42);
    const long = 'z'.repeat(700);
    expect(truncateValues('k', long)).toBe('z'.repeat(500) + '... [truncated, 700 chars]');
  });
});
