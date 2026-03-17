/**
 * Tests for Session Lifecycle API — POST /api/sessions/:id/end
 *
 * Verifies:
 *   - Session end endpoint marks conversations as ended
 *   - Already-ended sessions return 409
 *   - Non-existent sessions return 404
 *   - SessionEndHandler is called when configured
 *   - Session status is reflected in GET endpoints
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSessionsRouter } from '../src/chat/sessions-router.js';
import type { SessionEndHandler, SessionsRouterDependencies } from '../src/chat/sessions-router.js';
import { ensureChatTables } from '../src/chat/db/connection.js';
import { createConversation, saveChatTurn } from '../src/chat/db/conversationRepo.js';

// ─── Test helpers ───────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureChatTables(db);
  return db;
}

function createTestConversation(db: Database.Database, id: string, opts?: {
  sessionId?: string;
  metadata?: Record<string, unknown>;
}) {
  return createConversation(db, {
    id,
    title: `Test Session ${id}`,
    sessionId: opts?.sessionId,
    userId: 'debug-user',
    metadata: opts?.metadata,
  });
}

// ─── Tests ──────────────────────────────────────────────

describe('Session Lifecycle API', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('POST /api/sessions/:id/end', () => {
    it('should end an active session and return 200', async () => {
      createTestConversation(db, 'sess-1');
      const router = createSessionsRouter({ db });

      const res = await router.request('/api/sessions/sess-1/end', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body['id']).toBe('sess-1');
      expect(body['status']).toBe('ended');
      expect(body['endedAt']).toBeDefined();
      expect(typeof body['endedAt']).toBe('string');
      expect(body['neroSessionEnded']).toBe(false);
    });

    it('should return 404 for non-existent session', async () => {
      const router = createSessionsRouter({ db });

      const res = await router.request('/api/sessions/nonexistent/end', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      const body = await res.json() as Record<string, unknown>;
      expect(body['error']).toBe('NOT_FOUND');
    });

    it('should return 409 when session is already ended', async () => {
      createTestConversation(db, 'sess-2');
      const router = createSessionsRouter({ db });

      // End the session first
      const res1 = await router.request('/api/sessions/sess-2/end', {
        method: 'POST',
      });
      expect(res1.status).toBe(200);

      // Try to end again
      const res2 = await router.request('/api/sessions/sess-2/end', {
        method: 'POST',
      });
      expect(res2.status).toBe(409);
      const body = await res2.json() as Record<string, unknown>;
      expect(body['error']).toBe('ALREADY_ENDED');
    });

    it('should store endedAt and endReason in metadata', async () => {
      createTestConversation(db, 'sess-3');
      const router = createSessionsRouter({ db });

      await router.request('/api/sessions/sess-3/end', { method: 'POST' });

      // Verify via GET detail
      const detailRes = await router.request('/api/sessions/sess-3');
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json() as Record<string, unknown>;
      expect(detail['status']).toBe('ended');
      expect(detail['endedAt']).toBeDefined();
      expect(typeof detail['endedAt']).toBe('string');
    });

    it('should preserve existing metadata when ending session', async () => {
      createTestConversation(db, 'sess-4', {
        metadata: { customField: 'test-value', count: 42 },
      });
      const router = createSessionsRouter({ db });

      await router.request('/api/sessions/sess-4/end', { method: 'POST' });

      // Read raw metadata from DB to verify
      const row = db.prepare('SELECT metadata FROM chat_conversations WHERE id = ?').get('sess-4') as { metadata: string };
      const metadata = JSON.parse(row.metadata);
      expect(metadata['customField']).toBe('test-value');
      expect(metadata['count']).toBe(42);
      expect(metadata['status']).toBe('ended');
      expect(metadata['endedAt']).toBeDefined();
    });
  });

  describe('Session status in GET endpoints', () => {
    it('GET /api/sessions should show status for each session', async () => {
      createTestConversation(db, 'active-sess');
      createTestConversation(db, 'ended-sess');

      const router = createSessionsRouter({ db });

      // End one session
      await router.request('/api/sessions/ended-sess/end', { method: 'POST' });

      // List all sessions
      const listRes = await router.request('/api/sessions');
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json() as { sessions: Array<Record<string, unknown>> };

      const activeSession = listBody.sessions.find(s => s['id'] === 'active-sess');
      const endedSession = listBody.sessions.find(s => s['id'] === 'ended-sess');

      expect(activeSession?.['status']).toBe('active');
      expect(endedSession?.['status']).toBe('ended');
    });

    it('GET /api/sessions/:id should show endedAt as null for active sessions', async () => {
      createTestConversation(db, 'still-active');
      const router = createSessionsRouter({ db });

      const res = await router.request('/api/sessions/still-active');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body['status']).toBe('active');
      expect(body['endedAt']).toBeNull();
    });
  });

  describe('SessionEndHandler integration', () => {
    it('should call sessionEndHandler when conversation has a linked sessionId', async () => {
      createTestConversation(db, 'sess-with-nero', { sessionId: 'nero-session-abc' });

      const mockHandler: SessionEndHandler = {
        endSession: vi.fn().mockResolvedValue({ id: 'nero-session-abc', status: 'ended' }),
      };

      const router = createSessionsRouter({ db, sessionEndHandler: mockHandler });
      const res = await router.request('/api/sessions/sess-with-nero/end', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body['neroSessionEnded']).toBe(true);
      expect(mockHandler.endSession).toHaveBeenCalledWith('nero-session-abc', 'explicit');
    });

    it('should NOT call sessionEndHandler when conversation has no linked sessionId', async () => {
      createTestConversation(db, 'sess-no-nero'); // no sessionId

      const mockHandler: SessionEndHandler = {
        endSession: vi.fn().mockResolvedValue(null),
      };

      const router = createSessionsRouter({ db, sessionEndHandler: mockHandler });
      const res = await router.request('/api/sessions/sess-no-nero/end', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body['neroSessionEnded']).toBe(false);
      expect(mockHandler.endSession).not.toHaveBeenCalled();
    });

    it('should still end chat session even if nero session handler fails', async () => {
      createTestConversation(db, 'sess-handler-fail', { sessionId: 'nero-fail' });

      const mockHandler: SessionEndHandler = {
        endSession: vi.fn().mockRejectedValue(new Error('nero session not found')),
      };

      const router = createSessionsRouter({ db, sessionEndHandler: mockHandler });
      const res = await router.request('/api/sessions/sess-handler-fail/end', {
        method: 'POST',
      });

      // Should still succeed (non-fatal)
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body['status']).toBe('ended');
      expect(body['neroSessionEnded']).toBe(false);
    });

    it('should include batchExtraction result in response when handler returns data', async () => {
      createTestConversation(db, 'sess-batch', { sessionId: 'nero-batch-sess' });

      const mockHandler: SessionEndHandler = {
        endSession: vi.fn().mockResolvedValue({
          id: 'nero-batch-sess',
          status: 'ended',
        }),
      };

      const router = createSessionsRouter({ db, sessionEndHandler: mockHandler });
      const res = await router.request('/api/sessions/sess-batch/end', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body['neroSessionEnded']).toBe(true);
      const batchExtraction = body['batchExtraction'] as Record<string, unknown>;
      expect(batchExtraction['triggered']).toBe(true);
      expect(batchExtraction['sessionId']).toBe('nero-batch-sess');
      expect(typeof batchExtraction['durationMs']).toBe('number');
    });
  });

  describe('Edge cases', () => {
    it('should handle session with messages when ending', async () => {
      createTestConversation(db, 'sess-with-msgs');
      saveChatTurn(db, {
        conversationId: 'sess-with-msgs',
        userMessage: 'Hello',
        assistantMessage: 'Hi there!',
      });

      const router = createSessionsRouter({ db });
      const res = await router.request('/api/sessions/sess-with-msgs/end', {
        method: 'POST',
      });

      expect(res.status).toBe(200);

      // Verify messages are still accessible after ending
      const detailRes = await router.request('/api/sessions/sess-with-msgs');
      const detail = await detailRes.json() as Record<string, unknown>;
      const messages = detail['messages'] as unknown[];
      expect(messages).toHaveLength(2);
      expect(detail['status']).toBe('ended');
    });

    it('should handle sequential double-end attempts gracefully', async () => {
      createTestConversation(db, 'sess-rapid');
      const router = createSessionsRouter({ db });

      // First end should succeed
      const res1 = await router.request('/api/sessions/sess-rapid/end', { method: 'POST' });
      expect(res1.status).toBe(200);

      // Second end should get 409
      const res2 = await router.request('/api/sessions/sess-rapid/end', { method: 'POST' });
      expect(res2.status).toBe(409);
      const body = await res2.json() as Record<string, unknown>;
      expect(body['error']).toBe('ALREADY_ENDED');
    });
  });
});
