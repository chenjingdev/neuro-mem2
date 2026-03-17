/**
 * Integration tests for the Sessions API endpoints.
 *
 * Tests GET /api/sessions and GET /api/sessions/:id using in-memory SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { ensureChatTables } from '../src/chat/db/connection.js';
import { createSessionsRouter } from '../src/chat/sessions-router.js';
import {
  createConversation,
  createMessage,
} from '../src/chat/db/conversationRepo.js';
import { saveTraceEvents } from '../src/chat/db/traceRepo.js';
import type { TraceEvent } from '../src/chat/trace-types.js';

// ─── Helpers ─────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureChatTables(db);
  return db;
}

function createTestApp(db: Database.Database): Hono {
  const router = createSessionsRouter({ db });
  const app = new Hono();
  app.route('/', router);
  return app;
}

async function fetchJSON(app: Hono, path: string) {
  const res = await app.request(path);
  const body = await res.json();
  return { res, body };
}

function seedConversation(
  db: Database.Database,
  opts?: { id?: string; title?: string; messageCount?: number },
) {
  const id = opts?.id ?? uuid();
  createConversation(db, {
    id,
    title: opts?.title ?? `Session ${id.slice(0, 8)}`,
    userId: 'debug-user',
  });

  const msgCount = opts?.messageCount ?? 0;
  for (let i = 0; i < msgCount; i++) {
    createMessage(db, {
      id: uuid(),
      conversationId: id,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`,
      turnIndex: i,
    });
  }

  return id;
}

function makeTraceEvents(count: number): TraceEvent[] {
  const events: TraceEvent[] = [];
  const stages = ['recall', 'vector_search', 'llm', 'ingestion'] as const;
  for (let i = 0; i < count; i++) {
    events.push({
      id: i + 1,
      stage: stages[i % stages.length]!,
      status: i % 2 === 0 ? 'start' : 'complete',
      timestamp: new Date().toISOString(),
      durationMs: i % 2 === 1 ? 42 : undefined,
    });
  }
  return events;
}

// ─── GET /api/sessions ──────────────────────────────────

describe('GET /api/sessions', () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    app = createTestApp(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty array when no sessions exist', async () => {
    const { res, body } = await fetchJSON(app, '/api/sessions');
    expect(res.status).toBe(200);
    expect(body.sessions).toEqual([]);
    expect(body.pagination).toEqual({ limit: 50, offset: 0, count: 0 });
  });

  it('returns session list with correct fields', async () => {
    const id1 = seedConversation(db, { title: 'Test Session', messageCount: 4 });
    const id2 = seedConversation(db, { title: 'Another', messageCount: 2 });

    const { res, body } = await fetchJSON(app, '/api/sessions');
    expect(res.status).toBe(200);
    expect(body.sessions).toHaveLength(2);

    // Sessions are sorted by updated_at DESC, so the last seeded comes first
    for (const session of body.sessions) {
      expect(session).toHaveProperty('id');
      expect(session).toHaveProperty('title');
      expect(session).toHaveProperty('createdAt');
      expect(session).toHaveProperty('messageCount');
      expect(session).toHaveProperty('status');
      expect(typeof session.messageCount).toBe('number');
      expect(session.status).toBe('active');
    }

    // Find the session with 4 messages
    const s1 = body.sessions.find((s: any) => s.id === id1);
    expect(s1).toBeDefined();
    expect(s1.title).toBe('Test Session');
    expect(s1.messageCount).toBe(4);
  });

  it('respects limit and offset parameters', async () => {
    for (let i = 0; i < 5; i++) {
      seedConversation(db, { title: `S${i}`, messageCount: 1 });
    }

    const { body: page1 } = await fetchJSON(app, '/api/sessions?limit=2&offset=0');
    expect(page1.sessions).toHaveLength(2);
    expect(page1.pagination).toEqual({ limit: 2, offset: 0, count: 2 });

    const { body: page2 } = await fetchJSON(app, '/api/sessions?limit=2&offset=2');
    expect(page2.sessions).toHaveLength(2);

    const { body: page3 } = await fetchJSON(app, '/api/sessions?limit=2&offset=4');
    expect(page3.sessions).toHaveLength(1);
  });

  it('handles invalid limit/offset gracefully', async () => {
    seedConversation(db, { messageCount: 1 });

    const { res, body } = await fetchJSON(app, '/api/sessions?limit=abc&offset=-1');
    expect(res.status).toBe(200);
    // Should fall back to defaults
    expect(body.sessions).toHaveLength(1);
  });
});

// ─── GET /api/sessions/:id ──────────────────────────────

describe('GET /api/sessions/:id', () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    app = createTestApp(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns 404 for non-existent session', async () => {
    const { res, body } = await fetchJSON(app, '/api/sessions/does-not-exist');
    expect(res.status).toBe(404);
    expect(body.error).toBe('NOT_FOUND');
  });

  it('returns full session detail with messages', async () => {
    const id = seedConversation(db, { title: 'Debug Session', messageCount: 4 });

    const { res, body } = await fetchJSON(app, `/api/sessions/${id}`);
    expect(res.status).toBe(200);
    expect(body.id).toBe(id);
    expect(body.title).toBe('Debug Session');
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
    expect(body.userId).toBe('debug-user');
    expect(body.status).toBe('active');
    expect(body.endedAt).toBeNull();
    expect(body.messages).toHaveLength(4);

    // Check messages are sorted by turnIndex
    for (let i = 0; i < body.messages.length; i++) {
      expect(body.messages[i].turnIndex).toBe(i);
      expect(body.messages[i]).toHaveProperty('id');
      expect(body.messages[i]).toHaveProperty('role');
      expect(body.messages[i]).toHaveProperty('content');
      expect(body.messages[i]).toHaveProperty('createdAt');
    }
  });

  it('returns timeline trace events for the session', async () => {
    const convId = seedConversation(db, { title: 'Traced', messageCount: 2 });

    // Create an assistant message to associate trace events with
    const assistantMsgId = uuid();
    createMessage(db, {
      id: assistantMsgId,
      conversationId: convId,
      role: 'assistant',
      content: 'Traced response',
      turnIndex: 2,
    });

    // Save trace events
    const traces = makeTraceEvents(4);
    saveTraceEvents(db, convId, assistantMsgId, traces);

    const { res, body } = await fetchJSON(app, `/api/sessions/${convId}`);
    expect(res.status).toBe(200);
    expect(body.timeline).toHaveLength(4);

    for (const event of body.timeline) {
      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('messageId');
      expect(event).toHaveProperty('stage');
      expect(event).toHaveProperty('status');
      expect(event).toHaveProperty('timestamp');
      expect(event.messageId).toBe(assistantMsgId);
    }
  });

  it('returns empty timeline when no trace events exist', async () => {
    const id = seedConversation(db, { messageCount: 2 });

    const { res, body } = await fetchJSON(app, `/api/sessions/${id}`);
    expect(res.status).toBe(200);
    expect(body.timeline).toEqual([]);
    expect(body.messages).toHaveLength(2);
  });

  it('returns empty messages for session with no messages', async () => {
    const id = seedConversation(db, { messageCount: 0 });

    const { res, body } = await fetchJSON(app, `/api/sessions/${id}`);
    expect(res.status).toBe(200);
    expect(body.messages).toEqual([]);
    expect(body.timeline).toEqual([]);
  });
});

// ─── Integration: mount in main router ──────────────────

describe('Sessions router mounted in main router', () => {
  it('can be mounted at root and serves /api/sessions', async () => {
    const db = createTestDb();
    const router = createSessionsRouter({ db });
    const mainApp = new Hono();
    mainApp.route('/', router);

    seedConversation(db, { title: 'Mounted' });

    const res = await mainApp.request('/api/sessions');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].title).toBe('Mounted');

    db.close();
  });
});

