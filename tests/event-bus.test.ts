#!/usr/bin/env tsx
/**
 * Unit tests for orchestration/event-bus.ts
 * Tests: subscribe, emit, ring buffer, throttled subscriptions, clear
 */

import { suite, section, assert, assertEq, printSummary, resetResults } from './test-harness.js';
import { EventBus } from '../packages/core/src/orchestration/event-bus.js';
import type { WorkerEvent } from '../packages/core/src/orchestration/types.js';

// ── Helper ──────────────────────────────────────────────────────

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

// ── Tests ───────────────────────────────────────────────────────

resetResults();
suite('EventBus — subscribe, emit, ring buffer, throttle');

// ── Basic subscribe/emit ────────────────────────────────────────

section('subscribe and emit — channel match');
{
  const bus = new EventBus();
  const received: WorkerEvent[] = [];
  bus.subscribe('n1', (e) => { received.push(e); });

  bus.emit(makeEvent({ nodeId: 'n1' }));
  assertEq(received.length, 1, 'handler receives event on matching nodeId channel');
  bus.clear();
}

section('subscribe and emit — wildcard channel');
{
  const bus = new EventBus();
  const received: WorkerEvent[] = [];
  bus.subscribe('*', (e) => { received.push(e); });

  bus.emit(makeEvent({ nodeId: 'n1' }));
  bus.emit(makeEvent({ nodeId: 'n2' }));
  assertEq(received.length, 2, 'wildcard subscriber receives all events');
  bus.clear();
}

section('subscribe and emit — workerId channel');
{
  const bus = new EventBus();
  const received: WorkerEvent[] = [];
  bus.subscribe('w1', (e) => { received.push(e); });

  bus.emit(makeEvent({ workerId: 'w1', nodeId: 'other' }));
  assertEq(received.length, 1, 'handler receives event on matching workerId channel');
  bus.clear();
}

section('subscribe and emit — no match');
{
  const bus = new EventBus();
  const received: WorkerEvent[] = [];
  bus.subscribe('unrelated', (e) => { received.push(e); });

  bus.emit(makeEvent({ workerId: 'w1', nodeId: 'n1' }));
  assertEq(received.length, 0, 'non-matching channel receives nothing');
  bus.clear();
}

section('unsubscribe removes handler');
{
  const bus = new EventBus();
  const received: WorkerEvent[] = [];
  const unsub = bus.subscribe('n1', (e) => { received.push(e); });

  bus.emit(makeEvent({ nodeId: 'n1' }));
  assertEq(received.length, 1, 'received before unsubscribe');

  unsub();
  bus.emit(makeEvent({ nodeId: 'n1' }));
  assertEq(received.length, 1, 'no longer receives after unsubscribe');
  bus.clear();
}

section('multiple subscribers on same channel');
{
  const bus = new EventBus();
  let count1 = 0;
  let count2 = 0;
  bus.subscribe('n1', () => { count1++; });
  bus.subscribe('n1', () => { count2++; });

  bus.emit(makeEvent({ nodeId: 'n1' }));
  assertEq(count1, 1, 'first handler called');
  assertEq(count2, 1, 'second handler called');
  bus.clear();
}

section('handler errors are swallowed');
{
  const bus = new EventBus();
  let afterErrorCalled = false;
  bus.subscribe('n1', () => { throw new Error('boom'); });
  bus.subscribe('n1', () => { afterErrorCalled = true; });

  bus.emit(makeEvent({ nodeId: 'n1' }));
  assert(afterErrorCalled, 'second handler still called after first throws');
  bus.clear();
}

// ── Ring Buffer ─────────────────────────────────────────────────

section('ring buffer — stores recent events');
{
  const bus = new EventBus(5);
  for (let i = 0; i < 3; i++) {
    bus.emit(makeEvent({ message: `event-${i}` }));
  }
  const recent = bus.getRecentEvents(10);
  assertEq(recent.length, 3, 'returns all 3 events');
  assertEq(recent[0].message, 'event-0', 'oldest first');
  assertEq(recent[2].message, 'event-2', 'newest last');
  bus.clear();
}

section('ring buffer — wraps around');
{
  const bus = new EventBus(3);
  for (let i = 0; i < 5; i++) {
    bus.emit(makeEvent({ message: `event-${i}` }));
  }
  const recent = bus.getRecentEvents(10);
  assertEq(recent.length, 3, 'capped at buffer size');
  assertEq(recent[0].message, 'event-2', 'oldest retained event');
  assertEq(recent[2].message, 'event-4', 'newest event');
  bus.clear();
}

section('ring buffer — limit parameter');
{
  const bus = new EventBus(10);
  for (let i = 0; i < 8; i++) {
    bus.emit(makeEvent({ message: `event-${i}` }));
  }
  const recent = bus.getRecentEvents(3);
  assertEq(recent.length, 3, 'respects limit parameter');
  assertEq(recent[0].message, 'event-5', 'returns last 3 events');
  bus.clear();
}

section('ring buffer — empty');
{
  const bus = new EventBus();
  const recent = bus.getRecentEvents();
  assertEq(recent.length, 0, 'empty buffer returns empty array');
  bus.clear();
}

// ── Throttled subscriptions ─────────────────────────────────────

section('throttled — immediate types bypass batch');
{
  const bus = new EventBus();
  const received: WorkerEvent[] = [];

  const unsub = bus.subscribeThrottled('n1', (e) => { received.push(e); }, {
    throttleMs: 60_000, // very long interval
    immediateTypes: ['error', 'done'],
  });

  bus.emit(makeEvent({ nodeId: 'n1', type: 'error', message: 'immediate' }));
  assertEq(received.length, 1, 'immediate type fires right away');
  assertEq(received[0].message, 'immediate', 'immediate event received');

  unsub();
  bus.clear();
}

section('throttled — non-immediate types are batched then flushed on unsub');
{
  const bus = new EventBus();
  const received: WorkerEvent[] = [];

  const unsub = bus.subscribeThrottled('n1', (e) => { received.push(e); }, {
    throttleMs: 60_000,
    immediateTypes: ['done'],
  });

  bus.emit(makeEvent({ nodeId: 'n1', type: 'status', message: 'batched1' }));
  bus.emit(makeEvent({ nodeId: 'n1', type: 'status', message: 'batched2' }));
  assertEq(received.length, 0, 'batched events not delivered yet');

  unsub(); // flush on unsubscribe
  assertEq(received.length, 2, 'batched events flushed on unsubscribe');
  bus.clear();
}

section('throttled — immediate event flushes pending batch first');
{
  const bus = new EventBus();
  const received: WorkerEvent[] = [];

  const unsub = bus.subscribeThrottled('n1', (e) => { received.push(e); }, {
    throttleMs: 60_000,
    immediateTypes: ['done'],
  });

  bus.emit(makeEvent({ nodeId: 'n1', type: 'status', message: 'batched' }));
  bus.emit(makeEvent({ nodeId: 'n1', type: 'done', message: 'immediate' }));
  assertEq(received.length, 2, 'pending batch flushed before immediate event');
  assertEq(received[0].message, 'batched', 'batched event comes first');
  assertEq(received[1].message, 'immediate', 'immediate event comes second');

  unsub();
  bus.clear();
}

// ── clear() ─────────────────────────────────────────────────────

section('clear — removes subscribers and buffer');
{
  const bus = new EventBus();
  const received: WorkerEvent[] = [];
  bus.subscribe('n1', (e) => { received.push(e); });
  bus.emit(makeEvent({ nodeId: 'n1' }));
  assertEq(received.length, 1, 'received before clear');

  bus.clear();
  assertEq(bus.getRecentEvents().length, 0, 'buffer reset after clear');
  bus.emit(makeEvent({ nodeId: 'n1' }));
  assertEq(received.length, 1, 'no events delivered after clear (subscribers removed)');
}

const ok = printSummary('EventBus Tests');
process.exit(ok ? 0 : 1);
