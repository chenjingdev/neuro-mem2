/**
 * Tests for chat/db/traceRepo — trace event persistent storage and queries.
 *
 * Validates:
 * - saveTraceEvent / saveTraceEvents (from TraceCollector format)
 * - savePipelineTraceEvents (from chat-router SSE format)
 * - getTraceEventsByMessage / getTraceEventsByConversation / getTraceEventsByStage
 * - getTraceTimeline / getTraceTimelineWithData
 * - getTraceStats
 * - deleteTraceEventsByConversation
 * - createPersistingListener
 * - Data conversion (decomposeEventData) correctness
 * - JSON serialization/deserialization round-trip
 * - Transaction atomicity
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { openChatDatabase } from '../src/chat/db/connection.js';
import {
  saveTraceEvent,
  saveTraceEvents,
  savePipelineTraceEvents,
  getTraceEventsByMessage,
  getTraceEventsByConversation,
  getTraceEventsByStage,
  getTraceTimeline,
  getTraceTimelineWithData,
  getTraceStats,
  deleteTraceEventsByConversation,
  createPersistingListener,
} from '../src/chat/db/traceRepo.js';
import type { StoredTraceEvent, PipelineTraceEvent } from '../src/chat/db/traceRepo.js';
import type { TraceEvent } from '../src/chat/trace-types.js';

// ─── Fixtures ──────────────────────────────────────────────

let db: Database.Database;
let convId: string;
let msgId: string;

function setupConversationAndMessage() {
  convId = uuid();
  msgId = uuid();
  db.prepare(
    `INSERT INTO chat_conversations (id, user_id) VALUES (?, ?)`,
  ).run(convId, 'debug-user');
  db.prepare(
    `INSERT INTO chat_messages (id, conversation_id, role, content, turn_index)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(msgId, convId, 'assistant', 'Hi there', 1);
}

function makeTraceEvent(overrides: Partial<TraceEvent> & { id: number; stage: any; status: any }): TraceEvent {
  return {
    timestamp: new Date().toISOString(),
    ...overrides,
  } as TraceEvent;
}

function makePipelineEvent(overrides: Partial<PipelineTraceEvent>): PipelineTraceEvent {
  return {
    stage: 'recall',
    status: 'start',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Setup / Teardown ──────────────────────────────────────

beforeEach(() => {
  db = openChatDatabase({ inMemory: true });
  setupConversationAndMessage();
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
});

// ─── saveTraceEvent (single) ───────────────────────────────

describe('saveTraceEvent', () => {
  it('inserts a single trace event and returns row ID', () => {
    const event = makeTraceEvent({
      id: 1,
      stage: 'vector_search',
      status: 'start',
      input: { queryText: 'test query', topK: 10 },
    });

    const rowId = saveTraceEvent(db, convId, msgId, event);
    expect(rowId).toBeGreaterThan(0);
  });

  it('persists all fields correctly', () => {
    const event = makeTraceEvent({
      id: 1,
      stage: 'vector_search',
      status: 'complete',
      output: { matchedAnchors: [{ anchorId: 'a1', label: 'test', similarity: 0.9 }], itemCount: 1, timedOut: false },
      durationMs: 42.5,
      parentStage: 'recall',
    });

    saveTraceEvent(db, convId, msgId, event);

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored).toHaveLength(1);
    const s = stored[0]!;
    expect(s.conversationId).toBe(convId);
    expect(s.messageId).toBe(msgId);
    expect(s.traceId).toBe(1);
    expect(s.stage).toBe('vector_search');
    expect(s.status).toBe('complete');
    expect(s.durationMs).toBe(42.5);
    expect(s.parentStage).toBe('recall');
    expect(s.output).toEqual({
      matchedAnchors: [{ anchorId: 'a1', label: 'test', similarity: 0.9 }],
      itemCount: 1,
      timedOut: false,
    });
  });

  it('handles null optional fields', () => {
    const event = makeTraceEvent({
      id: 1,
      stage: 'recall',
      status: 'start',
    });

    saveTraceEvent(db, convId, msgId, event);

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored[0]!.input).toBeUndefined();
    expect(stored[0]!.output).toBeUndefined();
    expect(stored[0]!.error).toBeUndefined();
    expect(stored[0]!.skipReason).toBeUndefined();
    expect(stored[0]!.durationMs).toBeUndefined();
    expect(stored[0]!.parentStage).toBeUndefined();
  });

  it('persists error and skipReason fields', () => {
    const errorEvent = makeTraceEvent({
      id: 1,
      stage: 'recall',
      status: 'error',
      error: 'Connection timeout',
      durationMs: 5000,
    });
    saveTraceEvent(db, convId, msgId, errorEvent);

    const skippedEvent = makeTraceEvent({
      id: 2,
      stage: 'reinforce',
      status: 'skipped',
      skipReason: 'No edges to reinforce',
    });
    saveTraceEvent(db, convId, msgId, skippedEvent);

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored).toHaveLength(2);
    expect(stored[0]!.error).toBe('Connection timeout');
    expect(stored[1]!.skipReason).toBe('No edges to reinforce');
  });
});

// ─── saveTraceEvents (batch) ───────────────────────────────

describe('saveTraceEvents', () => {
  it('inserts multiple events in a transaction', () => {
    const events: TraceEvent[] = [
      makeTraceEvent({ id: 1, stage: 'recall', status: 'start' }),
      makeTraceEvent({ id: 2, stage: 'vector_search', status: 'start', parentStage: 'recall' }),
      makeTraceEvent({ id: 3, stage: 'vector_search', status: 'complete', durationMs: 10, parentStage: 'recall' }),
      makeTraceEvent({ id: 4, stage: 'recall', status: 'complete', durationMs: 15 }),
    ];

    const ids = saveTraceEvents(db, convId, msgId, events);
    expect(ids).toHaveLength(4);

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored).toHaveLength(4);
    expect(stored.map(s => s.stage)).toEqual(['recall', 'vector_search', 'vector_search', 'recall']);
    expect(stored.map(s => s.status)).toEqual(['start', 'start', 'complete', 'complete']);
  });

  it('returns empty array for empty input', () => {
    const ids = saveTraceEvents(db, convId, msgId, []);
    expect(ids).toEqual([]);
  });
});

// ─── savePipelineTraceEvents (chat-router bridge) ──────────

describe('savePipelineTraceEvents', () => {
  it('saves pipeline trace events with correct decomposition', () => {
    const events: PipelineTraceEvent[] = [
      makePipelineEvent({ stage: 'recall', status: 'start', data: { query: 'hello', userId: 'debug-user' } }),
      makePipelineEvent({ stage: 'recall', status: 'complete', durationMs: 25.5, data: { itemCount: 3 } }),
      makePipelineEvent({ stage: 'format', status: 'start', data: { itemCount: 3, format: 'numbered-list' } }),
      makePipelineEvent({ stage: 'format', status: 'complete', durationMs: 0.5, data: { charCount: 200, truncated: false } }),
      makePipelineEvent({ stage: 'llm', status: 'start', data: { provider: 'openai', messageCount: 2 } }),
      makePipelineEvent({ stage: 'llm', status: 'complete', durationMs: 1500, data: { responseLength: 100 } }),
      makePipelineEvent({ stage: 'pipeline', status: 'complete', durationMs: 1600, data: { stages: [] } }),
    ];

    const ids = savePipelineTraceEvents(db, convId, msgId, events);
    expect(ids).toHaveLength(7);

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored).toHaveLength(7);

    // start events → data stored as input
    expect(stored[0]!.input).toEqual({ query: 'hello', userId: 'debug-user' });
    expect(stored[0]!.output).toBeUndefined();

    // complete events → data stored as output
    expect(stored[1]!.output).toEqual({ itemCount: 3 });
    expect(stored[1]!.input).toBeUndefined();
    expect(stored[1]!.durationMs).toBe(25.5);
  });

  it('decomposes error events correctly', () => {
    const events: PipelineTraceEvent[] = [
      makePipelineEvent({
        stage: 'recall',
        status: 'error',
        durationMs: 5000,
        data: { error: 'Connection timeout', partial: true },
      }),
    ];

    savePipelineTraceEvents(db, convId, msgId, events);

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored[0]!.error).toBe('Connection timeout');
    expect(stored[0]!.output).toEqual({ partial: true }); // rest of data preserved as output
    expect(stored[0]!.durationMs).toBe(5000);
  });

  it('decomposes skipped events correctly', () => {
    const events: PipelineTraceEvent[] = [
      makePipelineEvent({
        stage: 'recall',
        status: 'skipped',
        data: { reason: 'No retriever configured' },
      }),
    ];

    savePipelineTraceEvents(db, convId, msgId, events);

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored[0]!.skipReason).toBe('No retriever configured');
    expect(stored[0]!.status).toBe('skipped');
  });

  it('handles events with no data gracefully', () => {
    const events: PipelineTraceEvent[] = [
      makePipelineEvent({ stage: 'llm', status: 'start' }),
      makePipelineEvent({ stage: 'llm', status: 'complete', durationMs: 100 }),
    ];

    savePipelineTraceEvents(db, convId, msgId, events);

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored).toHaveLength(2);
    expect(stored[0]!.input).toBeUndefined();
    expect(stored[1]!.output).toBeUndefined();
  });

  it('assigns monotonic trace_ids starting from 1', () => {
    const events: PipelineTraceEvent[] = [
      makePipelineEvent({ stage: 'recall', status: 'start' }),
      makePipelineEvent({ stage: 'recall', status: 'complete', durationMs: 10 }),
      makePipelineEvent({ stage: 'llm', status: 'start' }),
    ];

    savePipelineTraceEvents(db, convId, msgId, events);

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored.map(s => s.traceId)).toEqual([1, 2, 3]);
  });

  it('returns empty array for empty input', () => {
    const ids = savePipelineTraceEvents(db, convId, msgId, []);
    expect(ids).toEqual([]);
  });

  it('saves a full pipeline sequence (recall → format → inject → llm → ingestion → pipeline)', () => {
    const events: PipelineTraceEvent[] = [
      makePipelineEvent({ stage: 'recall', status: 'start', data: { query: 'test' } }),
      makePipelineEvent({ stage: 'recall', status: 'complete', durationMs: 20, data: { itemCount: 2 } }),
      makePipelineEvent({ stage: 'format', status: 'start', data: { itemCount: 2 } }),
      makePipelineEvent({ stage: 'format', status: 'complete', durationMs: 1, data: { charCount: 150 } }),
      makePipelineEvent({ stage: 'inject', status: 'start', data: { hasMemoryContext: true } }),
      makePipelineEvent({ stage: 'inject', status: 'complete', durationMs: 0.5, data: { finalPromptLength: 300 } }),
      makePipelineEvent({ stage: 'llm', status: 'start', data: { provider: 'openai' } }),
      makePipelineEvent({ stage: 'llm', status: 'complete', durationMs: 800, data: { responseLength: 50 } }),
      makePipelineEvent({ stage: 'ingestion', status: 'start', data: { mode: 'handler' } }),
      makePipelineEvent({ stage: 'ingestion', status: 'complete', durationMs: 200, data: { factCount: 1 } }),
      makePipelineEvent({ stage: 'pipeline', status: 'complete', durationMs: 1050, data: { stages: [] } }),
    ];

    savePipelineTraceEvents(db, convId, msgId, events);

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored).toHaveLength(11);

    // Timeline should show all terminal events
    const timeline = getTraceTimeline(db, msgId);
    expect(timeline).toHaveLength(6); // recall + format + inject + llm + ingestion + pipeline (all complete)
    expect(timeline.map(t => t.stage)).toEqual(['recall', 'format', 'inject', 'llm', 'ingestion', 'pipeline']);
    expect(timeline.every(t => t.status === 'complete')).toBe(true);
  });
});

// ─── Query functions ───────────────────────────────────────

describe('getTraceEventsByMessage', () => {
  it('returns events ordered by trace_id', () => {
    const events: TraceEvent[] = [
      makeTraceEvent({ id: 3, stage: 'merge', status: 'start' }),
      makeTraceEvent({ id: 1, stage: 'recall', status: 'start' }),
      makeTraceEvent({ id: 2, stage: 'vector_search', status: 'start' }),
    ];
    saveTraceEvents(db, convId, msgId, events);

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored.map(s => s.traceId)).toEqual([1, 2, 3]);
  });

  it('returns empty array for unknown message', () => {
    expect(getTraceEventsByMessage(db, 'nonexistent')).toEqual([]);
  });
});

describe('getTraceEventsByConversation', () => {
  it('returns events from all messages in a conversation', () => {
    const msgId2 = uuid();
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, turn_index) VALUES (?, ?, ?, ?, ?)`,
    ).run(msgId2, convId, 'assistant', 'Second reply', 3);

    saveTraceEvent(db, convId, msgId, makeTraceEvent({ id: 1, stage: 'recall', status: 'start' }));
    saveTraceEvent(db, convId, msgId2, makeTraceEvent({ id: 1, stage: 'llm', status: 'start' }));

    const stored = getTraceEventsByConversation(db, convId);
    expect(stored).toHaveLength(2);
    expect(stored[0]!.messageId).toBe(msgId);
    expect(stored[1]!.messageId).toBe(msgId2);
  });
});

describe('getTraceEventsByStage', () => {
  it('returns events filtered by stage', () => {
    saveTraceEvents(db, convId, msgId, [
      makeTraceEvent({ id: 1, stage: 'recall', status: 'start' }),
      makeTraceEvent({ id: 2, stage: 'vector_search', status: 'start' }),
      makeTraceEvent({ id: 3, stage: 'vector_search', status: 'complete', durationMs: 10 }),
      makeTraceEvent({ id: 4, stage: 'recall', status: 'complete', durationMs: 15 }),
    ]);

    const vectorEvents = getTraceEventsByStage(db, 'vector_search');
    expect(vectorEvents).toHaveLength(2);
    expect(vectorEvents.every(e => e.stage === 'vector_search')).toBe(true);
  });

  it('filters by status', () => {
    saveTraceEvents(db, convId, msgId, [
      makeTraceEvent({ id: 1, stage: 'recall', status: 'start' }),
      makeTraceEvent({ id: 2, stage: 'recall', status: 'complete', durationMs: 15 }),
    ]);

    const completeOnly = getTraceEventsByStage(db, 'recall', { status: 'complete' });
    expect(completeOnly).toHaveLength(1);
    expect(completeOnly[0]!.status).toBe('complete');
  });

  it('respects limit option', () => {
    saveTraceEvents(db, convId, msgId, [
      makeTraceEvent({ id: 1, stage: 'recall', status: 'start' }),
      makeTraceEvent({ id: 2, stage: 'recall', status: 'complete', durationMs: 15 }),
    ]);

    const limited = getTraceEventsByStage(db, 'recall', { limit: 1 });
    expect(limited).toHaveLength(1);
  });
});

// ─── getTraceTimeline ──────────────────────────────────────

describe('getTraceTimeline', () => {
  it('returns only terminal events (complete/error/skipped), one per stage', () => {
    saveTraceEvents(db, convId, msgId, [
      makeTraceEvent({ id: 1, stage: 'recall', status: 'start' }),
      makeTraceEvent({ id: 2, stage: 'recall', status: 'complete', durationMs: 20 }),
      makeTraceEvent({ id: 3, stage: 'llm', status: 'start' }),
      makeTraceEvent({ id: 4, stage: 'llm', status: 'complete', durationMs: 100 }),
      makeTraceEvent({ id: 5, stage: 'ingestion', status: 'skipped', skipReason: 'No handler' }),
    ]);

    const timeline = getTraceTimeline(db, msgId);
    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toEqual({ stage: 'recall', status: 'complete', durationMs: 20, parentStage: undefined });
    expect(timeline[1]).toEqual({ stage: 'llm', status: 'complete', durationMs: 100, parentStage: undefined });
    expect(timeline[2]).toEqual({ stage: 'ingestion', status: 'skipped', durationMs: undefined, parentStage: undefined });
  });

  it('keeps last terminal event when stage has multiple terminals', () => {
    // This can happen if a stage errored first then was retried
    saveTraceEvents(db, convId, msgId, [
      makeTraceEvent({ id: 1, stage: 'llm', status: 'start' }),
      makeTraceEvent({ id: 2, stage: 'llm', status: 'error', error: 'timeout', durationMs: 5000 }),
      makeTraceEvent({ id: 3, stage: 'llm', status: 'complete', durationMs: 200 }),
    ]);

    const timeline = getTraceTimeline(db, msgId);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.status).toBe('complete');
    expect(timeline[0]!.durationMs).toBe(200);
  });

  it('returns empty array for unknown message', () => {
    expect(getTraceTimeline(db, 'nonexistent')).toEqual([]);
  });
});

// ─── getTraceTimelineWithData ──────────────────────────────

describe('getTraceTimelineWithData', () => {
  it('returns all events with full data for timeline rendering', () => {
    savePipelineTraceEvents(db, convId, msgId, [
      makePipelineEvent({ stage: 'recall', status: 'start', data: { query: 'test' } }),
      makePipelineEvent({ stage: 'recall', status: 'complete', durationMs: 20, data: { itemCount: 3 } }),
      makePipelineEvent({ stage: 'llm', status: 'start', data: { provider: 'openai' } }),
      makePipelineEvent({ stage: 'llm', status: 'complete', durationMs: 500, data: { responseLength: 100 } }),
    ]);

    const timeline = getTraceTimelineWithData(db, msgId);
    expect(timeline).toHaveLength(4);

    // All events are included (not just terminal)
    expect(timeline[0]!.stage).toBe('recall');
    expect(timeline[0]!.status).toBe('start');
    expect(timeline[0]!.input).toEqual({ query: 'test' });

    expect(timeline[1]!.stage).toBe('recall');
    expect(timeline[1]!.status).toBe('complete');
    expect(timeline[1]!.output).toEqual({ itemCount: 3 });
    expect(timeline[1]!.durationMs).toBe(20);

    expect(timeline[3]!.stage).toBe('llm');
    expect(timeline[3]!.status).toBe('complete');
    expect(timeline[3]!.output).toEqual({ responseLength: 100 });
  });

  it('returns empty array for unknown message', () => {
    expect(getTraceTimelineWithData(db, 'nonexistent')).toEqual([]);
  });
});

// ─── getTraceStats ─────────────────────────────────────────

describe('getTraceStats', () => {
  it('computes statistics for a conversation', () => {
    savePipelineTraceEvents(db, convId, msgId, [
      makePipelineEvent({ stage: 'recall', status: 'start' }),
      makePipelineEvent({ stage: 'recall', status: 'complete', durationMs: 20 }),
      makePipelineEvent({ stage: 'llm', status: 'start' }),
      makePipelineEvent({ stage: 'llm', status: 'complete', durationMs: 500 }),
      makePipelineEvent({ stage: 'ingestion', status: 'skipped' }),
      makePipelineEvent({ stage: 'pipeline', status: 'complete', durationMs: 550 }),
    ]);

    const stats = getTraceStats(db, convId);
    expect(stats.totalEvents).toBe(6);
    expect(stats.byStage['recall']).toBe(2);
    expect(stats.byStage['llm']).toBe(2);
    expect(stats.byStage['ingestion']).toBe(1);
    expect(stats.byStage['pipeline']).toBe(1);
    expect(stats.byStatus['start']).toBe(2);
    expect(stats.byStatus['complete']).toBe(3);
    expect(stats.byStatus['skipped']).toBe(1);
    expect(stats.avgDurationByStage['recall']).toBe(20); // only 1 has duration
    expect(stats.avgDurationByStage['llm']).toBe(500);
  });

  it('returns zeros for empty conversation', () => {
    const stats = getTraceStats(db, 'nonexistent');
    expect(stats.totalEvents).toBe(0);
    expect(Object.keys(stats.byStage)).toHaveLength(0);
    expect(Object.keys(stats.byStatus)).toHaveLength(0);
    expect(Object.keys(stats.avgDurationByStage)).toHaveLength(0);
  });
});

// ─── deleteTraceEventsByConversation ───────────────────────

describe('deleteTraceEventsByConversation', () => {
  it('deletes all events for a conversation', () => {
    saveTraceEvents(db, convId, msgId, [
      makeTraceEvent({ id: 1, stage: 'recall', status: 'start' }),
      makeTraceEvent({ id: 2, stage: 'recall', status: 'complete', durationMs: 10 }),
    ]);

    const deleted = deleteTraceEventsByConversation(db, convId);
    expect(deleted).toBe(2);

    const remaining = getTraceEventsByConversation(db, convId);
    expect(remaining).toEqual([]);
  });

  it('returns 0 for nonexistent conversation', () => {
    const deleted = deleteTraceEventsByConversation(db, 'nonexistent');
    expect(deleted).toBe(0);
  });

  it('does not affect other conversations', () => {
    const convId2 = uuid();
    const msgId2 = uuid();
    db.prepare('INSERT INTO chat_conversations (id, user_id) VALUES (?, ?)').run(convId2, 'debug-user');
    db.prepare(
      'INSERT INTO chat_messages (id, conversation_id, role, content, turn_index) VALUES (?, ?, ?, ?, ?)',
    ).run(msgId2, convId2, 'assistant', 'Other', 1);

    saveTraceEvent(db, convId, msgId, makeTraceEvent({ id: 1, stage: 'recall', status: 'start' }));
    saveTraceEvent(db, convId2, msgId2, makeTraceEvent({ id: 1, stage: 'llm', status: 'start' }));

    deleteTraceEventsByConversation(db, convId);

    expect(getTraceEventsByConversation(db, convId)).toHaveLength(0);
    expect(getTraceEventsByConversation(db, convId2)).toHaveLength(1);
  });
});

// ─── createPersistingListener ──────────────────────────────

describe('createPersistingListener', () => {
  it('creates a listener that persists events on each call', () => {
    const listener = createPersistingListener(db, convId, msgId);

    listener(makeTraceEvent({ id: 1, stage: 'recall', status: 'start', input: { queryText: 'hello' } }));
    listener(makeTraceEvent({ id: 2, stage: 'recall', status: 'complete', durationMs: 15 }));

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored).toHaveLength(2);
    expect(stored[0]!.stage).toBe('recall');
    expect(stored[0]!.input).toEqual({ queryText: 'hello' });
  });

  it('does not throw on DB errors (logs instead)', () => {
    // Close the DB to force an error
    const closedDb = new Database(':memory:');
    openChatDatabase({ db: closedDb }); // apply schema
    closedDb.close();

    const listener = createPersistingListener(closedDb, convId, msgId);

    // Should not throw
    expect(() => {
      listener(makeTraceEvent({ id: 1, stage: 'recall', status: 'start' }));
    }).not.toThrow();
  });
});

// ─── JSON round-trip ───────────────────────────────────────

describe('JSON serialization round-trip', () => {
  it('preserves complex nested objects in input/output', () => {
    const complexData = {
      nested: { deep: { value: [1, 2, 3] } },
      unicode: '한국어 テスト',
      numbers: { float: 3.14, negative: -42, zero: 0 },
      booleans: { yes: true, no: false },
      nullVal: null,
    };

    const event = makeTraceEvent({
      id: 1,
      stage: 'vector_search',
      status: 'complete',
      output: complexData,
    });

    saveTraceEvent(db, convId, msgId, event);

    const stored = getTraceEventsByMessage(db, msgId);
    expect(stored[0]!.output).toEqual(complexData);
  });

  it('preserves arrays in input/output', () => {
    const event = makeTraceEvent({
      id: 1,
      stage: 'merge',
      status: 'complete',
      output: { items: ['a', 'b', 'c'], counts: [1, 2, 3] },
    });

    saveTraceEvent(db, convId, msgId, event);

    const stored = getTraceEventsByMessage(db, msgId);
    expect((stored[0]!.output as any).items).toEqual(['a', 'b', 'c']);
  });
});

// ─── Cross-message isolation ───────────────────────────────

describe('cross-message isolation', () => {
  it('getTraceEventsByMessage returns only events for that message', () => {
    const msgId2 = uuid();
    db.prepare(
      'INSERT INTO chat_messages (id, conversation_id, role, content, turn_index) VALUES (?, ?, ?, ?, ?)',
    ).run(msgId2, convId, 'assistant', 'Second reply', 3);

    saveTraceEvent(db, convId, msgId, makeTraceEvent({ id: 1, stage: 'recall', status: 'start' }));
    saveTraceEvent(db, convId, msgId2, makeTraceEvent({ id: 1, stage: 'llm', status: 'start' }));

    expect(getTraceEventsByMessage(db, msgId)).toHaveLength(1);
    expect(getTraceEventsByMessage(db, msgId)[0]!.stage).toBe('recall');
    expect(getTraceEventsByMessage(db, msgId2)).toHaveLength(1);
    expect(getTraceEventsByMessage(db, msgId2)[0]!.stage).toBe('llm');
  });
});
