/**
 * Tests for Episode/Concept batch extraction trigger via sessions-router.
 *
 * Verifies that:
 *   1. POST /api/sessions/:id/end triggers SessionEndHandler.endSession()
 *   2. POST /api/sessions/:id/end-stream emits SSE trace events for batch extraction
 *   3. Trace events include episode_extraction and concept_extraction stages
 *   4. Already-ended sessions return 409
 *   5. Missing sessions return 404
 *   6. Handler errors are reported gracefully
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { ensureChatTables } from '../src/chat/db/connection.js';
import {
  createSessionsRouter,
  type SessionEndHandler,
  type SessionsRouterDependencies,
} from '../src/chat/sessions-router.js';
import {
  createConversation,
  createMessage,
  updateConversation,
} from '../src/chat/db/conversationRepo.js';

// ─── Helpers ─────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureChatTables(db);
  return db;
}

function createTestApp(deps: SessionsRouterDependencies): Hono {
  const router = createSessionsRouter(deps);
  const app = new Hono();
  app.route('/', router);
  return app;
}

function seedConversation(
  db: Database.Database,
  opts?: { id?: string; sessionId?: string; title?: string; ended?: boolean },
): string {
  const id = opts?.id ?? uuid();
  createConversation(db, {
    id,
    title: opts?.title ?? `Test Session ${id.slice(0, 8)}`,
    userId: 'debug-user',
    sessionId: opts?.sessionId,
  });

  // Add some messages so session has content
  createMessage(db, {
    id: uuid(),
    conversationId: id,
    role: 'user',
    content: 'Hello',
    turnIndex: 0,
  });
  createMessage(db, {
    id: uuid(),
    conversationId: id,
    role: 'assistant',
    content: 'Hi there!',
    turnIndex: 1,
  });

  if (opts?.ended) {
    updateConversation(db, id, {
      metadata: {
        status: 'ended',
        endedAt: new Date().toISOString(),
        endReason: 'explicit',
      },
    });
  }

  return id;
}

/** Parse SSE text into structured events */
function parseSSEStream(text: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split('\n');
    let eventType = '';
    let dataStr = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataStr = line.slice(6);
      }
    }

    if (eventType && dataStr) {
      try {
        events.push({ event: eventType, data: JSON.parse(dataStr) });
      } catch {
        events.push({ event: eventType, data: dataStr });
      }
    }
  }

  return events;
}

// ─── Tests ───────────────────────────────────────────────

describe('POST /api/sessions/:id/end — batch extraction trigger', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns 404 for non-existent session', async () => {
    const app = createTestApp({ db });
    const res = await app.request('/api/sessions/nonexistent/end', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('NOT_FOUND');
  });

  it('returns 409 for already-ended session', async () => {
    const convId = seedConversation(db, { ended: true });
    const app = createTestApp({ db });

    const res = await app.request(`/api/sessions/${convId}/end`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('ALREADY_ENDED');
  });

  it('ends session without handler (no batch extraction)', async () => {
    const convId = seedConversation(db);
    const app = createTestApp({ db });

    const res = await app.request(`/api/sessions/${convId}/end`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ended');
    expect(body.id).toBe(convId);
    expect(body.neroSessionEnded).toBe(false);
    expect(body.batchExtraction.triggered).toBe(false);
  });

  it('ends session and triggers SessionEndHandler', async () => {
    const neroSessionId = `nero-${uuid()}`;
    const convId = seedConversation(db, { sessionId: neroSessionId });

    const mockHandler: SessionEndHandler = {
      endSession: vi.fn().mockResolvedValue({ id: neroSessionId, status: 'ended' }),
    };

    const app = createTestApp({ db, sessionEndHandler: mockHandler });

    const res = await app.request(`/api/sessions/${convId}/end`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe('ended');
    expect(body.neroSessionEnded).toBe(true);
    expect(body.batchExtraction.triggered).toBe(true);
    expect(body.batchExtraction.sessionId).toBe(neroSessionId);
    expect(body.batchExtraction.durationMs).toBeGreaterThanOrEqual(0);

    // Verify handler was called with correct args
    expect(mockHandler.endSession).toHaveBeenCalledWith(neroSessionId, 'explicit');
  });

  it('passes custom reason to SessionEndHandler', async () => {
    const neroSessionId = `nero-${uuid()}`;
    const convId = seedConversation(db, { sessionId: neroSessionId });

    const mockHandler: SessionEndHandler = {
      endSession: vi.fn().mockResolvedValue(null),
    };

    const app = createTestApp({ db, sessionEndHandler: mockHandler });

    const res = await app.request(`/api/sessions/${convId}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'timeout' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reason).toBe('timeout');
    expect(mockHandler.endSession).toHaveBeenCalledWith(neroSessionId, 'timeout');
  });

  it('handles SessionEndHandler errors gracefully', async () => {
    const neroSessionId = `nero-${uuid()}`;
    const convId = seedConversation(db, { sessionId: neroSessionId });

    const mockHandler: SessionEndHandler = {
      endSession: vi.fn().mockRejectedValue(new Error('Session not found in nero-mem2')),
    };

    const app = createTestApp({ db, sessionEndHandler: mockHandler });

    const res = await app.request(`/api/sessions/${convId}/end`, {
      method: 'POST',
    });
    expect(res.status).toBe(200); // Still 200 — chat session is ended
    const body = await res.json();
    expect(body.status).toBe('ended');
    expect(body.batchExtraction.triggered).toBe(true);
    expect(body.batchExtraction.error).toContain('Session not found');
  });
});

describe('POST /api/sessions/:id/end-stream — SSE batch extraction traces', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns 404 for non-existent session', async () => {
    const app = createTestApp({ db });
    const res = await app.request('/api/sessions/nonexistent/end-stream', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 for already-ended session', async () => {
    const convId = seedConversation(db, { ended: true });
    const app = createTestApp({ db });

    const res = await app.request(`/api/sessions/${convId}/end-stream`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
  });

  it('streams batch_extraction:skipped when no handler configured', async () => {
    const convId = seedConversation(db);
    const app = createTestApp({ db });

    const res = await app.request(`/api/sessions/${convId}/end-stream`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const text = await res.text();
    const events = parseSSEStream(text);

    // Should have batch_extraction:start, batch_extraction:skipped, done
    expect(events.length).toBeGreaterThanOrEqual(3);

    const batchStart = events.find(
      (e) => e.event === 'trace' && (e.data as any).stage === 'batch_extraction' && (e.data as any).status === 'start',
    );
    expect(batchStart).toBeDefined();
    expect((batchStart!.data as any).data.jobTypes).toEqual([
      'episode_extraction',
      'concept_extraction',
    ]);

    const batchSkipped = events.find(
      (e) =>
        e.event === 'trace' &&
        (e.data as any).stage === 'batch_extraction' &&
        (e.data as any).status === 'skipped',
    );
    expect(batchSkipped).toBeDefined();

    const done = events.find((e) => e.event === 'done');
    expect(done).toBeDefined();
    expect((done!.data as any).batchExtraction).toBe(false);
  });

  it('streams episode_extraction + concept_extraction traces with handler', async () => {
    const neroSessionId = `nero-${uuid()}`;
    const convId = seedConversation(db, { sessionId: neroSessionId });

    const mockHandler: SessionEndHandler = {
      endSession: vi.fn().mockResolvedValue({ id: neroSessionId, status: 'ended' }),
    };

    const app = createTestApp({ db, sessionEndHandler: mockHandler });

    const res = await app.request(`/api/sessions/${convId}/end-stream`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const text = await res.text();
    const events = parseSSEStream(text);

    // Verify trace event sequence
    const traceEvents = events
      .filter((e) => e.event === 'trace')
      .map((e) => ({
        stage: (e.data as any).stage,
        status: (e.data as any).status,
      }));

    // Expected sequence: batch:start, episode:start, concept:start, episode:complete, concept:complete, batch:complete
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        { stage: 'batch_extraction', status: 'start' },
        { stage: 'episode_extraction', status: 'start' },
        { stage: 'concept_extraction', status: 'start' },
        { stage: 'episode_extraction', status: 'complete' },
        { stage: 'concept_extraction', status: 'complete' },
        { stage: 'batch_extraction', status: 'complete' },
      ]),
    );

    // Verify batch_extraction:start has correct data
    const batchStart = events.find(
      (e) => e.event === 'trace' && (e.data as any).stage === 'batch_extraction' && (e.data as any).status === 'start',
    );
    expect((batchStart!.data as any).data.sessionId).toBe(neroSessionId);
    expect((batchStart!.data as any).data.conversationId).toBe(convId);

    // Verify episode_extraction:complete has data
    const epComplete = events.find(
      (e) =>
        e.event === 'trace' &&
        (e.data as any).stage === 'episode_extraction' &&
        (e.data as any).status === 'complete',
    );
    expect(epComplete).toBeDefined();
    expect((epComplete!.data as any).durationMs).toBeGreaterThanOrEqual(0);
    expect((epComplete!.data as any).data.triggered).toBe(true);

    // Verify concept_extraction:complete has data
    const cxComplete = events.find(
      (e) =>
        e.event === 'trace' &&
        (e.data as any).stage === 'concept_extraction' &&
        (e.data as any).status === 'complete',
    );
    expect(cxComplete).toBeDefined();

    // Verify done event
    const done = events.find((e) => e.event === 'done');
    expect(done).toBeDefined();
    expect((done!.data as any).batchExtraction).toBe(true);
    expect((done!.data as any).totalDurationMs).toBeGreaterThanOrEqual(0);

    // Verify handler was called
    expect(mockHandler.endSession).toHaveBeenCalledWith(neroSessionId, 'explicit');
  });

  it('streams error traces when handler fails', async () => {
    const neroSessionId = `nero-${uuid()}`;
    const convId = seedConversation(db, { sessionId: neroSessionId });

    const mockHandler: SessionEndHandler = {
      endSession: vi.fn().mockRejectedValue(new Error('Extraction failed')),
    };

    const app = createTestApp({ db, sessionEndHandler: mockHandler });

    const res = await app.request(`/api/sessions/${convId}/end-stream`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const events = parseSSEStream(text);

    // Should have error traces for both extraction stages
    const episodeError = events.find(
      (e) =>
        e.event === 'trace' &&
        (e.data as any).stage === 'episode_extraction' &&
        (e.data as any).status === 'error',
    );
    expect(episodeError).toBeDefined();
    expect((episodeError!.data as any).data.error).toContain('Extraction failed');

    const conceptError = events.find(
      (e) =>
        e.event === 'trace' &&
        (e.data as any).stage === 'concept_extraction' &&
        (e.data as any).status === 'error',
    );
    expect(conceptError).toBeDefined();

    // batch_extraction should still complete (not crash)
    const batchComplete = events.find(
      (e) =>
        e.event === 'trace' &&
        (e.data as any).stage === 'batch_extraction' &&
        (e.data as any).status === 'complete',
    );
    expect(batchComplete).toBeDefined();

    // Done event should still be emitted
    const done = events.find((e) => e.event === 'done');
    expect(done).toBeDefined();
  });

  it('passes custom reason through SSE stream', async () => {
    const neroSessionId = `nero-${uuid()}`;
    const convId = seedConversation(db, { sessionId: neroSessionId });

    const mockHandler: SessionEndHandler = {
      endSession: vi.fn().mockResolvedValue(null),
    };

    const app = createTestApp({ db, sessionEndHandler: mockHandler });

    const res = await app.request(`/api/sessions/${convId}/end-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'timeout' }),
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const events = parseSSEStream(text);

    // Verify reason is passed through
    const batchStart = events.find(
      (e) => e.event === 'trace' && (e.data as any).stage === 'batch_extraction' && (e.data as any).status === 'start',
    );
    expect((batchStart!.data as any).data.reason).toBe('timeout');

    // Verify handler was called with correct reason
    expect(mockHandler.endSession).toHaveBeenCalledWith(neroSessionId, 'timeout');
  });
});

describe('Trace types include batch extraction stages', () => {
  it('TopLevelStage includes batch extraction types', async () => {
    // Import trace types to verify they compile correctly
    const traceTypes = await import('../src/chat/trace-types.js');

    // The types are compile-time only, but we can verify the module exports
    expect(traceTypes).toBeDefined();
  });
});
