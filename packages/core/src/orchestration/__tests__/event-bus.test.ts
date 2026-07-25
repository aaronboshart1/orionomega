/**
 * @module __tests__/event-bus
 * Unit tests for orchestration/event-bus.ts — subscribe, emit, ring buffer,
 * throttled subscriptions, and clear.
 */

import { describe, it, expect } from 'vitest';
import { EventBus } from '../event-bus.js';
import type { WorkerEvent } from '../types.js';

function makeEvent(overrides: Partial<WorkerEvent> = {}): WorkerEvent {
  return {
    workerId: 'w1',
    nodeId: 'n1',
    timestamp: new Date().toISOString(),
    type: 'status',
    message: 'test',
    ...overrides,
  };
}

describe('EventBus — subscribe/emit', () => {
  it('delivers to a handler subscribed on the matching nodeId channel', () => {
    const bus = new EventBus();
    const received: WorkerEvent[] = [];
    bus.subscribe('n1', (e) => { received.push(e); });

    bus.emit(makeEvent({ nodeId: 'n1' }));
    expect(received).toHaveLength(1);
  });

  it('delivers every event to a wildcard subscriber', () => {
    const bus = new EventBus();
    const received: WorkerEvent[] = [];
    bus.subscribe('*', (e) => { received.push(e); });

    bus.emit(makeEvent({ nodeId: 'n1' }));
    bus.emit(makeEvent({ nodeId: 'n2' }));
    expect(received).toHaveLength(2);
  });

  it('delivers on the matching workerId channel', () => {
    const bus = new EventBus();
    const received: WorkerEvent[] = [];
    bus.subscribe('w1', (e) => { received.push(e); });

    bus.emit(makeEvent({ workerId: 'w1', nodeId: 'other' }));
    expect(received).toHaveLength(1);
  });

  it('delivers nothing on a non-matching channel', () => {
    const bus = new EventBus();
    const received: WorkerEvent[] = [];
    bus.subscribe('unrelated', (e) => { received.push(e); });

    bus.emit(makeEvent({ workerId: 'w1', nodeId: 'n1' }));
    expect(received).toHaveLength(0);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus();
    const received: WorkerEvent[] = [];
    const unsub = bus.subscribe('n1', (e) => { received.push(e); });

    bus.emit(makeEvent({ nodeId: 'n1' }));
    expect(received).toHaveLength(1);

    unsub();
    bus.emit(makeEvent({ nodeId: 'n1' }));
    expect(received).toHaveLength(1);
  });

  it('calls every subscriber on the same channel', () => {
    const bus = new EventBus();
    let count1 = 0;
    let count2 = 0;
    bus.subscribe('n1', () => { count1++; });
    bus.subscribe('n1', () => { count2++; });

    bus.emit(makeEvent({ nodeId: 'n1' }));
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });

  it('swallows a handler error so later handlers still run', () => {
    const bus = new EventBus();
    let afterErrorCalled = false;
    bus.subscribe('n1', () => { throw new Error('boom'); });
    bus.subscribe('n1', () => { afterErrorCalled = true; });

    bus.emit(makeEvent({ nodeId: 'n1' }));
    expect(afterErrorCalled).toBe(true);
  });
});

describe('EventBus — ring buffer', () => {
  it('stores recent events oldest-first', () => {
    const bus = new EventBus(5);
    for (let i = 0; i < 3; i++) bus.emit(makeEvent({ message: `event-${i}` }));

    const recent = bus.getRecentEvents(10);
    expect(recent).toHaveLength(3);
    expect(recent[0].message).toBe('event-0');
    expect(recent[2].message).toBe('event-2');
  });

  it('wraps around at capacity, dropping the oldest events', () => {
    const bus = new EventBus(3);
    for (let i = 0; i < 5; i++) bus.emit(makeEvent({ message: `event-${i}` }));

    const recent = bus.getRecentEvents(10);
    expect(recent).toHaveLength(3);
    expect(recent[0].message).toBe('event-2');
    expect(recent[2].message).toBe('event-4');
  });

  it('respects the limit parameter, returning the newest N', () => {
    const bus = new EventBus(10);
    for (let i = 0; i < 8; i++) bus.emit(makeEvent({ message: `event-${i}` }));

    const recent = bus.getRecentEvents(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].message).toBe('event-5');
  });

  it('returns an empty array when nothing has been emitted', () => {
    expect(new EventBus().getRecentEvents()).toHaveLength(0);
  });
});

describe('EventBus — throttled subscriptions', () => {
  it('delivers an immediate-type event without waiting for the batch interval', () => {
    const bus = new EventBus();
    const received: WorkerEvent[] = [];

    const unsub = bus.subscribeThrottled('n1', (e) => { received.push(e); }, {
      throttleMs: 60_000,
      immediateTypes: ['error', 'done'],
    });

    bus.emit(makeEvent({ nodeId: 'n1', type: 'error', message: 'immediate' }));
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe('immediate');

    unsub();
  });

  it('batches non-immediate events and flushes them on unsubscribe', () => {
    const bus = new EventBus();
    const received: WorkerEvent[] = [];

    const unsub = bus.subscribeThrottled('n1', (e) => { received.push(e); }, {
      throttleMs: 60_000,
      immediateTypes: ['done'],
    });

    bus.emit(makeEvent({ nodeId: 'n1', type: 'status', message: 'batched1' }));
    bus.emit(makeEvent({ nodeId: 'n1', type: 'status', message: 'batched2' }));
    expect(received).toHaveLength(0);

    unsub();
    expect(received).toHaveLength(2);
  });

  it('flushes the pending batch before delivering an immediate event', () => {
    const bus = new EventBus();
    const received: WorkerEvent[] = [];

    const unsub = bus.subscribeThrottled('n1', (e) => { received.push(e); }, {
      throttleMs: 60_000,
      immediateTypes: ['done'],
    });

    bus.emit(makeEvent({ nodeId: 'n1', type: 'status', message: 'batched' }));
    bus.emit(makeEvent({ nodeId: 'n1', type: 'done', message: 'immediate' }));
    expect(received).toHaveLength(2);
    expect(received[0].message).toBe('batched');
    expect(received[1].message).toBe('immediate');

    unsub();
  });
});

describe('EventBus — clear', () => {
  it('resets the buffer and removes subscribers', () => {
    const bus = new EventBus();
    const received: WorkerEvent[] = [];
    bus.subscribe('n1', (e) => { received.push(e); });
    bus.emit(makeEvent({ nodeId: 'n1' }));
    expect(received).toHaveLength(1);

    bus.clear();
    expect(bus.getRecentEvents()).toHaveLength(0);

    bus.emit(makeEvent({ nodeId: 'n1' }));
    expect(received).toHaveLength(1);
  });
});
