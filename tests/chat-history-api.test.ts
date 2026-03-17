/**
 * Integration tests for conversation/message/trace query API endpoints.
 *
 * Tests the full round-trip: insert data via repos → query via HTTP endpoints → verify response.
 * Uses in-memory SQLite for isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { ensureChatTables } from '../src/chat/db/connection.js';
import { createHistoryRouter } from '../src/chat/history-router.js';
import {
  createConversation,
  createMessage,
  getConversation,
  getMessagesByConversation,
  listConversations,
  updateConversation,
  deleteConversation,
  getMessage,
} from '../src/chat/db/conversationRepo.js';
import {
  saveTraceEvents,
  getTraceEventsByConversation,
} from '../src/chat/db/traceRepo.js';
import type { TraceEvent } from '../src/chat/trace-types.js';

// ─── Test helpers ────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureChatTables(db);
  return db;
}

function createTestApp(db: Database.Database): Hono {
  const router = createHistoryRouter({ db });
  const app = new Hono();
  app.route('/', router);
  return app;
}

async function fetchJSON(app: Hono, path: string, init?: RequestInit) {
  const res = await app.request(path, init);
  const body = await res.json();
  return { res, body };
}

function makeTraceEvents(count: number): TraceEvent[] {
  const events: TraceEvent[] = [];
  const stages = ['recall', 'vector_search', 'llm', 'ingestion'];
  for (let i = 0; i < count; i++) {
    const stage = stages[i % stages.length]!;
    events.push({
      id: i + 1,
      stage: stage as TraceEvent['stage'],
      status: i % 2 === 0 ? 'start' : 'complete',
      timestamp: new Date().toISOString(),
      durationMs: i % 2 === 1 ? Math.random() * 100 : undefined,
      input: i % 2 === 0 ? { query: 'test' } : undefined,
      output: i % 2 === 1 ? { results: [] } : undefined,
    });
  }
  return events;
}

// ─── Repository unit tests ──────────────────────────────

describe('conversationRepo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('createConversation', () => {
    it('creates a conversation with all fields', () => {
      const conv = createConversation(db, {
        id: 'conv-1',
        title: 'Test Conversation',
        sessionId: 'session-1',
        userId: 'debug-user',
        metadata: { provider: 'openai' },
      });

      expect(conv.id).toBe('conv-1');
      expect(conv.title).toBe('Test Conversation');
      expect(conv.sessionId).toBe('session-1');
      expect(conv.userId).toBe('debug-user');
      expect(conv.metadata).toEqual({ provider: 'openai' });
      expect(conv.createdAt).toBeTruthy();
    });

    it('creates a conversation with defaults', () => {
      const conv = createConversation(db, { id: 'conv-2' });
      expect(conv.userId).toBe('debug-user');
      expect(conv.title).toBeNull();
      expect(conv.sessionId).toBeNull();
    });
  });

  describe('getConversation', () => {
    it('retrieves an existing conversation', () => {
      createConversation(db, { id: 'conv-1', title: 'Hello' });
      const conv = getConversation(db, 'conv-1');
      expect(conv).not.toBeNull();
      expect(conv!.title).toBe('Hello');
    });

    it('returns null for non-existent conversation', () => {
      expect(getConversation(db, 'nonexistent')).toBeNull();
    });
  });

  describe('listConversations', () => {
    it('lists conversations ordered by updated_at desc', () => {
      // Create with explicit updated_at to control ordering
      createConversation(db, { id: 'conv-1', title: 'First' });
      createConversation(db, { id: 'conv-2', title: 'Second' });
      createConversation(db, { id: 'conv-3', title: 'Third' });

      // Manually update timestamps to ensure ordering
      db.prepare(`UPDATE chat_conversations SET updated_at = '2026-01-01T00:00:01Z' WHERE id = 'conv-1'`).run();
      db.prepare(`UPDATE chat_conversations SET updated_at = '2026-01-01T00:00:02Z' WHERE id = 'conv-2'`).run();
      db.prepare(`UPDATE chat_conversations SET updated_at = '2026-01-01T00:00:03Z' WHERE id = 'conv-3'`).run();

      const convs = listConversations(db);
      expect(convs).toHaveLength(3);
      // Most recent first
      expect(convs[0]!.id).toBe('conv-3');
    });

    it('includes message count', () => {
      createConversation(db, { id: 'conv-1' });
      createMessage(db, { id: 'msg-1', conversationId: 'conv-1', role: 'user', content: 'Hi', turnIndex: 0 });
      createMessage(db, { id: 'msg-2', conversationId: 'conv-1', role: 'assistant', content: 'Hello', turnIndex: 1 });

      const convs = listConversations(db);
      expect(convs[0]!.messageCount).toBe(2);
    });

    it('supports pagination', () => {
      for (let i = 0; i < 5; i++) {
        createConversation(db, { id: `conv-${i}` });
      }
      const page1 = listConversations(db, { limit: 2, offset: 0 });
      const page2 = listConversations(db, { limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0]!.id).not.toBe(page2[0]!.id);
    });

    it('filters by userId', () => {
      createConversation(db, { id: 'conv-1', userId: 'debug-user' });
      createConversation(db, { id: 'conv-2', userId: 'other-user' });

      const convs = listConversations(db, { userId: 'debug-user' });
      expect(convs).toHaveLength(1);
      expect(convs[0]!.userId).toBe('debug-user');
    });
  });

  describe('updateConversation', () => {
    it('updates title', () => {
      createConversation(db, { id: 'conv-1', title: 'Old' });
      const updated = updateConversation(db, 'conv-1', { title: 'New' });
      expect(updated).toBe(true);
      expect(getConversation(db, 'conv-1')!.title).toBe('New');
    });

    it('returns false for non-existent conversation', () => {
      expect(updateConversation(db, 'nope', { title: 'X' })).toBe(false);
    });
  });

  describe('deleteConversation', () => {
    it('deletes conversation and cascaded data', () => {
      createConversation(db, { id: 'conv-1' });
      createMessage(db, { id: 'msg-1', conversationId: 'conv-1', role: 'user', content: 'Hi', turnIndex: 0 });
      createMessage(db, { id: 'msg-2', conversationId: 'conv-1', role: 'assistant', content: 'Hello', turnIndex: 1 });

      // Add trace events
      saveTraceEvents(db, 'conv-1', 'msg-2', makeTraceEvents(4));

      const deleted = deleteConversation(db, 'conv-1');
      expect(deleted).toBe(true);
      expect(getConversation(db, 'conv-1')).toBeNull();
      expect(getMessagesByConversation(db, 'conv-1')).toHaveLength(0);
      expect(getTraceEventsByConversation(db, 'conv-1')).toHaveLength(0);
    });

    it('returns false for non-existent conversation', () => {
      expect(deleteConversation(db, 'nope')).toBe(false);
    });
  });

  describe('createMessage / getMessagesByConversation', () => {
    it('creates and retrieves messages in order', () => {
      createConversation(db, { id: 'conv-1' });
      createMessage(db, { id: 'msg-1', conversationId: 'conv-1', role: 'user', content: 'Hello', turnIndex: 0 });
      createMessage(db, { id: 'msg-2', conversationId: 'conv-1', role: 'assistant', content: 'Hi there', turnIndex: 1, model: 'gpt-4o', tokenCount: 50, durationMs: 234.5 });

      const msgs = getMessagesByConversation(db, 'conv-1');
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.role).toBe('user');
      expect(msgs[0]!.content).toBe('Hello');
      expect(msgs[1]!.role).toBe('assistant');
      expect(msgs[1]!.model).toBe('gpt-4o');
      expect(msgs[1]!.tokenCount).toBe(50);
      expect(msgs[1]!.durationMs).toBe(234.5);
    });

    it('getMessage retrieves a single message', () => {
      createConversation(db, { id: 'conv-1' });
      createMessage(db, { id: 'msg-1', conversationId: 'conv-1', role: 'user', content: 'Hello', turnIndex: 0 });

      const msg = getMessage(db, 'msg-1');
      expect(msg).not.toBeNull();
      expect(msg!.content).toBe('Hello');
    });

    it('getMessage returns null for non-existent message', () => {
      expect(getMessage(db, 'nope')).toBeNull();
    });
  });
});

// ─── HTTP endpoint integration tests ─────────────────────

describe('history-router HTTP endpoints', () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    app = createTestApp(db);
  });

  afterEach(() => {
    db.close();
  });

  // Helper: seed a conversation with messages and traces
  function seedConversation(id: string, messageCount = 2, traceCount = 4) {
    createConversation(db, { id, title: `Conv ${id}`, userId: 'debug-user' });
    const msgIds: string[] = [];
    for (let i = 0; i < messageCount; i++) {
      const msgId = `${id}-msg-${i}`;
      msgIds.push(msgId);
      createMessage(db, {
        id: msgId,
        conversationId: id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
        turnIndex: i,
        model: i % 2 === 1 ? 'gpt-4o' : undefined,
      });
    }
    // Attach traces to the last assistant message
    const assistantMsg = msgIds.find((_, idx) => idx % 2 === 1) ?? msgIds[0]!;
    if (traceCount > 0) {
      saveTraceEvents(db, id, assistantMsg, makeTraceEvents(traceCount));
    }
    return msgIds;
  }

  // ── GET /conversations ──

  describe('GET /conversations', () => {
    it('returns empty list when no conversations exist', async () => {
      const { res, body } = await fetchJSON(app, '/conversations');
      expect(res.status).toBe(200);
      expect(body.conversations).toEqual([]);
      expect(body.pagination).toEqual({ limit: 50, offset: 0, count: 0 });
    });

    it('returns all conversations with message counts', async () => {
      seedConversation('conv-1', 4);
      seedConversation('conv-2', 2);

      const { res, body } = await fetchJSON(app, '/conversations');
      expect(res.status).toBe(200);
      expect(body.conversations).toHaveLength(2);

      // Each conversation should have messageCount
      const conv1 = body.conversations.find((c: any) => c.id === 'conv-1');
      const conv2 = body.conversations.find((c: any) => c.id === 'conv-2');
      expect(conv1.messageCount).toBe(4);
      expect(conv2.messageCount).toBe(2);
    });

    it('supports pagination via limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        seedConversation(`conv-${i}`, 1, 0);
      }

      const { body: page1 } = await fetchJSON(app, '/conversations?limit=2&offset=0');
      expect(page1.conversations).toHaveLength(2);
      expect(page1.pagination).toEqual({ limit: 2, offset: 0, count: 2 });

      const { body: page2 } = await fetchJSON(app, '/conversations?limit=2&offset=2');
      expect(page2.conversations).toHaveLength(2);

      // No overlap
      const ids1 = page1.conversations.map((c: any) => c.id);
      const ids2 = page2.conversations.map((c: any) => c.id);
      expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
    });

    it('filters by userId query param', async () => {
      createConversation(db, { id: 'conv-1', userId: 'debug-user' });
      createConversation(db, { id: 'conv-2', userId: 'other-user' });

      const { body } = await fetchJSON(app, '/conversations?userId=debug-user');
      expect(body.conversations).toHaveLength(1);
      expect(body.conversations[0].userId).toBe('debug-user');
    });
  });

  // ── GET /conversations/:id ──

  describe('GET /conversations/:id', () => {
    it('returns a single conversation', async () => {
      seedConversation('conv-1');
      const { res, body } = await fetchJSON(app, '/conversations/conv-1');
      expect(res.status).toBe(200);
      expect(body.conversation.id).toBe('conv-1');
      expect(body.conversation.title).toBe('Conv conv-1');
    });

    it('returns 404 for non-existent conversation', async () => {
      const { res, body } = await fetchJSON(app, '/conversations/nonexistent');
      expect(res.status).toBe(404);
      expect(body.error).toBe('NOT_FOUND');
    });
  });

  // ── GET /conversations/:id/messages ──

  describe('GET /conversations/:id/messages', () => {
    it('returns messages ordered by turn_index', async () => {
      seedConversation('conv-1', 4);

      const { res, body } = await fetchJSON(app, '/conversations/conv-1/messages');
      expect(res.status).toBe(200);
      expect(body.conversationId).toBe('conv-1');
      expect(body.messages).toHaveLength(4);

      // Verify order
      for (let i = 0; i < body.messages.length; i++) {
        expect(body.messages[i].turnIndex).toBe(i);
      }
    });

    it('returns 404 for non-existent conversation', async () => {
      const { res, body } = await fetchJSON(app, '/conversations/nonexistent/messages');
      expect(res.status).toBe(404);
      expect(body.error).toBe('NOT_FOUND');
    });

    it('supports pagination', async () => {
      seedConversation('conv-1', 6, 0);

      const { body: page1 } = await fetchJSON(app, '/conversations/conv-1/messages?limit=3&offset=0');
      expect(page1.messages).toHaveLength(3);
      expect(page1.pagination.limit).toBe(3);

      const { body: page2 } = await fetchJSON(app, '/conversations/conv-1/messages?limit=3&offset=3');
      expect(page2.messages).toHaveLength(3);

      // First page starts at turnIndex 0, second at turnIndex 3
      expect(page1.messages[0].turnIndex).toBe(0);
      expect(page2.messages[0].turnIndex).toBe(3);
    });
  });

  // ── GET /traces/:conversationId ──

  describe('GET /traces/:conversationId', () => {
    it('returns trace events for a conversation', async () => {
      seedConversation('conv-1', 2, 6);

      const { res, body } = await fetchJSON(app, '/traces/conv-1');
      expect(res.status).toBe(200);
      expect(body.conversationId).toBe('conv-1');
      expect(body.traceEvents).toHaveLength(6);

      // Each event should have required fields
      for (const event of body.traceEvents) {
        expect(event.conversationId).toBe('conv-1');
        expect(event.stage).toBeTruthy();
        expect(event.status).toBeTruthy();
        expect(event.timestamp).toBeTruthy();
      }
    });

    it('returns empty trace array for conversation with no traces', async () => {
      seedConversation('conv-1', 2, 0);

      const { res, body } = await fetchJSON(app, '/traces/conv-1');
      expect(res.status).toBe(200);
      expect(body.traceEvents).toHaveLength(0);
    });

    it('returns 404 for non-existent conversation', async () => {
      const { res, body } = await fetchJSON(app, '/traces/nonexistent');
      expect(res.status).toBe(404);
      expect(body.error).toBe('NOT_FOUND');
    });

    it('supports timeline format', async () => {
      seedConversation('conv-1', 2, 4);

      const { res, body } = await fetchJSON(app, '/traces/conv-1?format=timeline');
      expect(res.status).toBe(200);
      expect(body.timelines).toBeDefined();
      expect(typeof body.timelines).toBe('object');
    });
  });

  // ── DELETE /conversations/:id ──

  describe('DELETE /conversations/:id', () => {
    it('deletes a conversation and returns success', async () => {
      seedConversation('conv-1', 2, 4);

      const { res, body } = await fetchJSON(app, '/conversations/conv-1', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      expect(body.deleted).toBe(true);
      expect(body.id).toBe('conv-1');

      // Verify it's gone
      const { res: res2 } = await fetchJSON(app, '/conversations/conv-1');
      expect(res2.status).toBe(404);
    });

    it('returns 404 for non-existent conversation', async () => {
      const { res, body } = await fetchJSON(app, '/conversations/nonexistent', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
      expect(body.error).toBe('NOT_FOUND');
    });
  });
});

// ─── Full round-trip persistence tests ───────────────────

describe('DB round-trip persistence', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('full lifecycle: create conv → add messages → add traces → query all → delete', () => {
    // 1. Create conversation
    const conv = createConversation(db, {
      id: 'rt-conv-1',
      title: 'Round-trip test',
      sessionId: 'session-abc',
      metadata: { test: true },
    });
    expect(conv.id).toBe('rt-conv-1');

    // 2. Add messages
    const userMsg = createMessage(db, {
      id: 'rt-msg-1',
      conversationId: 'rt-conv-1',
      role: 'user',
      content: 'What is the capital of France?',
      turnIndex: 0,
    });
    const assistantMsg = createMessage(db, {
      id: 'rt-msg-2',
      conversationId: 'rt-conv-1',
      role: 'assistant',
      content: 'The capital of France is Paris.',
      turnIndex: 1,
      model: 'gpt-4o',
      tokenCount: 12,
      durationMs: 500.3,
    });

    // 3. Add trace events
    const traces: TraceEvent[] = [
      { id: 1, stage: 'recall', status: 'start', timestamp: new Date().toISOString() },
      { id: 2, stage: 'vector_search', status: 'start', timestamp: new Date().toISOString(), input: { query: 'capital of France' } },
      { id: 3, stage: 'vector_search', status: 'complete', timestamp: new Date().toISOString(), durationMs: 15.2, output: { matchCount: 3 } },
      { id: 4, stage: 'recall', status: 'complete', timestamp: new Date().toISOString(), durationMs: 20.1 },
      { id: 5, stage: 'llm', status: 'start', timestamp: new Date().toISOString() },
      { id: 6, stage: 'llm', status: 'complete', timestamp: new Date().toISOString(), durationMs: 450.0 },
    ];
    saveTraceEvents(db, 'rt-conv-1', 'rt-msg-2', traces);

    // 4. Query and verify
    const retrievedConv = getConversation(db, 'rt-conv-1');
    expect(retrievedConv).not.toBeNull();
    expect(retrievedConv!.title).toBe('Round-trip test');
    expect(retrievedConv!.sessionId).toBe('session-abc');
    expect(retrievedConv!.metadata).toEqual({ test: true });

    const messages = getMessagesByConversation(db, 'rt-conv-1');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toBe('What is the capital of France?');
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[1]!.model).toBe('gpt-4o');
    expect(messages[1]!.tokenCount).toBe(12);
    expect(messages[1]!.durationMs).toBe(500.3);

    const traceEvents = getTraceEventsByConversation(db, 'rt-conv-1');
    expect(traceEvents).toHaveLength(6);
    expect(traceEvents[0]!.stage).toBe('recall');
    expect(traceEvents[1]!.input).toEqual({ query: 'capital of France' });
    expect(traceEvents[2]!.output).toEqual({ matchCount: 3 });
    expect(traceEvents[2]!.durationMs).toBe(15.2);

    // List should include this conversation with message count
    const allConvs = listConversations(db);
    expect(allConvs).toHaveLength(1);
    expect(allConvs[0]!.messageCount).toBe(2);

    // 5. Delete and verify clean removal
    const deleted = deleteConversation(db, 'rt-conv-1');
    expect(deleted).toBe(true);
    expect(getConversation(db, 'rt-conv-1')).toBeNull();
    expect(getMessagesByConversation(db, 'rt-conv-1')).toHaveLength(0);
    expect(getTraceEventsByConversation(db, 'rt-conv-1')).toHaveLength(0);
  });

  it('multiple conversations are isolated', () => {
    createConversation(db, { id: 'conv-a' });
    createConversation(db, { id: 'conv-b' });

    createMessage(db, { id: 'a-1', conversationId: 'conv-a', role: 'user', content: 'A msg', turnIndex: 0 });
    createMessage(db, { id: 'b-1', conversationId: 'conv-b', role: 'user', content: 'B msg', turnIndex: 0 });

    expect(getMessagesByConversation(db, 'conv-a')).toHaveLength(1);
    expect(getMessagesByConversation(db, 'conv-b')).toHaveLength(1);
    expect(getMessagesByConversation(db, 'conv-a')[0]!.content).toBe('A msg');
    expect(getMessagesByConversation(db, 'conv-b')[0]!.content).toBe('B msg');

    // Delete one doesn't affect the other
    deleteConversation(db, 'conv-a');
    expect(getConversation(db, 'conv-a')).toBeNull();
    expect(getConversation(db, 'conv-b')).not.toBeNull();
    expect(getMessagesByConversation(db, 'conv-b')).toHaveLength(1);
  });

  it('trace events with JSON input/output survive round-trip', () => {
    createConversation(db, { id: 'conv-1' });
    createMessage(db, { id: 'msg-1', conversationId: 'conv-1', role: 'assistant', content: 'test', turnIndex: 0 });

    const complexInput = {
      query: 'test query',
      filters: { minScore: 0.5, categories: ['fact', 'preference'] },
      nested: { deep: { value: [1, 2, 3] } },
    };
    const complexOutput = {
      results: [
        { id: 'r1', score: 0.95, content: 'Some fact' },
        { id: 'r2', score: 0.87, content: 'Another fact' },
      ],
      metadata: { totalTime: 42 },
    };

    const traces: TraceEvent[] = [
      {
        id: 1,
        stage: 'vector_search',
        status: 'start',
        timestamp: new Date().toISOString(),
        input: complexInput,
      },
      {
        id: 2,
        stage: 'vector_search',
        status: 'complete',
        timestamp: new Date().toISOString(),
        durationMs: 42.5,
        output: complexOutput,
      },
    ];

    saveTraceEvents(db, 'conv-1', 'msg-1', traces);

    const stored = getTraceEventsByConversation(db, 'conv-1');
    expect(stored).toHaveLength(2);
    expect(stored[0]!.input).toEqual(complexInput);
    expect(stored[1]!.output).toEqual(complexOutput);
    expect(stored[1]!.durationMs).toBe(42.5);
  });
});
