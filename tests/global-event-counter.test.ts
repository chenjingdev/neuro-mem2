/**
 * Tests for GlobalEventCounter and SystemStateRepository.
 *
 * Verifies:
 * - system_state KV table creation and CRUD
 * - Global event counter stored under 'global_event_counter' key
 * - turn.completed → +1.0 increment
 * - retrieval.completed → +0.3 increment
 * - Accumulation across multiple events
 * - Counter persistence across repository instances
 * - Manual increment/reset operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { EventBus } from '../src/events/event-bus.js';
import { SystemStateRepository } from '../src/db/system-state-repo.js';
import { CREATE_SYSTEM_STATE_TABLE } from '../src/db/system-state-schema.js';
import {
  GlobalEventCounter,
  GLOBAL_EVENT_COUNTER_KEY,
  EVENT_INCREMENTS,
} from '../src/services/global-event-counter.js';

describe('SystemStateRepository', () => {
  let db: Database.Database;
  let repo: SystemStateRepository;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    // system_state table is created by createDatabase via connection.ts
    repo = new SystemStateRepository(db);
  });

  it('returns null for non-existent string key', () => {
    expect(repo.getString('nonexistent')).toBeNull();
  });

  it('returns 0 for non-existent numeric key', () => {
    expect(repo.getNumber('nonexistent')).toBe(0);
  });

  it('sets and gets a string value', () => {
    repo.set('test_key', 'hello');
    expect(repo.getString('test_key')).toBe('hello');
  });

  it('sets and gets a numeric value', () => {
    repo.setNumber('counter', 42.5);
    expect(repo.getNumber('counter')).toBe(42.5);
  });

  it('upserts on duplicate key', () => {
    repo.set('key', 'v1');
    repo.set('key', 'v2');
    expect(repo.getString('key')).toBe('v2');
  });

  it('increments a non-existent key (initializes to delta)', () => {
    const result = repo.increment('counter', 1.0);
    expect(result).toBe(1.0);
  });

  it('increments an existing key by delta', () => {
    repo.setNumber('counter', 5.0);
    const result = repo.increment('counter', 1.0);
    expect(result).toBe(6.0);
  });

  it('increments with fractional delta', () => {
    repo.setNumber('counter', 1.0);
    const result = repo.increment('counter', 0.3);
    expect(result).toBeCloseTo(1.3, 10);
  });

  it('increments multiple times accumulate correctly', () => {
    repo.increment('counter', 1.0);
    repo.increment('counter', 0.3);
    repo.increment('counter', 0.3);
    repo.increment('counter', 1.0);
    expect(repo.getNumber('counter')).toBeCloseTo(2.6, 10);
  });

  it('deletes a key', () => {
    repo.set('key', 'value');
    expect(repo.delete('key')).toBe(true);
    expect(repo.getString('key')).toBeNull();
  });

  it('delete returns false for non-existent key', () => {
    expect(repo.delete('nonexistent')).toBe(false);
  });

  it('getAll returns all key-value pairs', () => {
    repo.set('a', '1');
    repo.set('b', '2');
    const all = repo.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].key).toBe('a');
    expect(all[1].key).toBe('b');
  });
});

describe('GlobalEventCounter', () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let counter: GlobalEventCounter;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    eventBus = new EventBus();
    counter = new GlobalEventCounter(db, eventBus);
    counter.start();
  });

  afterEach(() => {
    counter.stop();
    eventBus.clear();
  });

  it('starts at 0', () => {
    expect(counter.current()).toBe(0);
  });

  it('increments by 1.0 on turn.completed', async () => {
    await eventBus.emit({
      type: 'turn.completed',
      conversationId: 'conv-1',
      message: {
        id: 'msg-1',
        role: 'user',
        content: 'hello',
        turnIndex: 0,
        createdAt: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });

    expect(counter.current()).toBe(1.0);
  });

  it('increments by 0.3 on retrieval.completed', async () => {
    await eventBus.emit({
      type: 'retrieval.completed',
      queryText: 'test query',
      resultCount: 5,
      totalTimeMs: 100,
      timestamp: new Date().toISOString(),
    });

    expect(counter.current()).toBeCloseTo(0.3, 10);
  });

  it('accumulates across multiple turn.completed events', async () => {
    for (let i = 0; i < 3; i++) {
      await eventBus.emit({
        type: 'turn.completed',
        conversationId: 'conv-1',
        message: {
          id: `msg-${i}`,
          role: 'user',
          content: 'hello',
          turnIndex: i,
          createdAt: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });
    }

    expect(counter.current()).toBe(3.0);
  });

  it('accumulates across mixed event types', async () => {
    // 2 turns (+2.0) + 3 retrievals (+0.9) = 2.9
    await eventBus.emit({
      type: 'turn.completed',
      conversationId: 'conv-1',
      message: { id: 'msg-1', role: 'user', content: 'hi', turnIndex: 0, createdAt: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });
    await eventBus.emit({
      type: 'retrieval.completed',
      queryText: 'q1',
      resultCount: 3,
      totalTimeMs: 50,
      timestamp: new Date().toISOString(),
    });
    await eventBus.emit({
      type: 'retrieval.completed',
      queryText: 'q2',
      resultCount: 2,
      totalTimeMs: 30,
      timestamp: new Date().toISOString(),
    });
    await eventBus.emit({
      type: 'turn.completed',
      conversationId: 'conv-1',
      message: { id: 'msg-2', role: 'assistant', content: 'hey', turnIndex: 1, createdAt: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });
    await eventBus.emit({
      type: 'retrieval.completed',
      queryText: 'q3',
      resultCount: 1,
      totalTimeMs: 20,
      timestamp: new Date().toISOString(),
    });

    expect(counter.current()).toBeCloseTo(2.9, 10);
  });

  it('does not increment on unrelated events', async () => {
    await eventBus.emit({
      type: 'session.ended',
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      reason: 'explicit',
      timestamp: new Date().toISOString(),
    });

    expect(counter.current()).toBe(0);
  });

  it('stops incrementing after stop()', async () => {
    await eventBus.emit({
      type: 'turn.completed',
      conversationId: 'conv-1',
      message: { id: 'msg-1', role: 'user', content: 'hi', turnIndex: 0, createdAt: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });
    expect(counter.current()).toBe(1.0);

    counter.stop();

    await eventBus.emit({
      type: 'turn.completed',
      conversationId: 'conv-1',
      message: { id: 'msg-2', role: 'user', content: 'yo', turnIndex: 1, createdAt: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });

    // Should still be 1.0 since we stopped
    expect(counter.current()).toBe(1.0);
  });

  it('reset() sets counter back to 0', async () => {
    await eventBus.emit({
      type: 'turn.completed',
      conversationId: 'conv-1',
      message: { id: 'msg-1', role: 'user', content: 'hi', turnIndex: 0, createdAt: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });
    expect(counter.current()).toBe(1.0);

    counter.reset();
    expect(counter.current()).toBe(0);
  });

  it('manual increment works', () => {
    const result = counter.increment('turn.completed');
    expect(result).toBe(1.0);
    expect(counter.current()).toBe(1.0);
  });

  it('incrementBy works with arbitrary delta', () => {
    counter.incrementBy(5.5);
    expect(counter.current()).toBe(5.5);
  });

  it('counter value persists in system_state table', async () => {
    await eventBus.emit({
      type: 'turn.completed',
      conversationId: 'conv-1',
      message: { id: 'msg-1', role: 'user', content: 'hi', turnIndex: 0, createdAt: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });

    // Create a new counter instance pointing to the same DB
    const counter2 = new GlobalEventCounter(db, eventBus);
    expect(counter2.current()).toBe(1.0);
  });

  it('stores counter under correct key in system_state', async () => {
    await eventBus.emit({
      type: 'turn.completed',
      conversationId: 'conv-1',
      message: { id: 'msg-1', role: 'user', content: 'hi', turnIndex: 0, createdAt: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });

    // Verify directly in the DB
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(GLOBAL_EVENT_COUNTER_KEY) as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(parseFloat(row!.value)).toBe(1.0);
  });

  it('supports custom increment values', async () => {
    counter.stop();
    const customCounter = new GlobalEventCounter(db, eventBus, {
      increments: { 'turn.completed': 2.0, 'retrieval.completed': 0.5 },
    });
    customCounter.reset();
    customCounter.start();

    await eventBus.emit({
      type: 'turn.completed',
      conversationId: 'conv-1',
      message: { id: 'msg-1', role: 'user', content: 'hi', turnIndex: 0, createdAt: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });

    expect(customCounter.current()).toBe(2.0);
    customCounter.stop();
  });

  it('exports correct default increment constants', () => {
    expect(EVENT_INCREMENTS['turn.completed']).toBe(1.0);
    expect(EVENT_INCREMENTS['retrieval.completed']).toBe(0.3);
  });
});

describe('system_state table DDL', () => {
  it('table is created by createDatabase', () => {
    const db = createDatabase({ inMemory: true });
    // Should not throw — table exists
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='system_state'").get() as { name: string } | undefined;
    expect(result).toBeDefined();
    expect(result!.name).toBe('system_state');
  });

  it('table has correct columns', () => {
    const db = createDatabase({ inMemory: true });
    const columns = db.prepare("PRAGMA table_info('system_state')").all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const colNames = columns.map(c => c.name);
    expect(colNames).toContain('key');
    expect(colNames).toContain('value');
    expect(colNames).toContain('updated_at');

    // key is primary key
    const keyCol = columns.find(c => c.name === 'key');
    expect(keyCol?.pk).toBe(1);
  });

  it('CREATE_SYSTEM_STATE_TABLE is idempotent', () => {
    const db = createDatabase({ inMemory: true });
    // Running again should not throw
    expect(() => db.exec(CREATE_SYSTEM_STATE_TABLE)).not.toThrow();
  });
});
