/**
 * Tests for REST API Router — POST /ingest, POST /ingest/append, POST /recall, GET /health
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { IngestService } from '../src/services/ingest.js';
import { createRouter, type RouterDependencies } from '../src/api/router.js';
import {
  validateIngestConversation,
  validateAppendMessage,
  validateRecallRequest,
} from '../src/api/schemas.js';
import type { Hono } from 'hono';

// ─── Helper: make a request to the Hono app ──────────────

async function request(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

// ─── Schema Validation Tests ─────────────────────────────

describe('Schema Validation', () => {
  describe('validateIngestConversation', () => {
    it('returns no errors for valid input', () => {
      const errors = validateIngestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(errors).toHaveLength(0);
    });

    it('requires source field', () => {
      const errors = validateIngestConversation({
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(errors.some(e => e.field === 'source')).toBe(true);
    });

    it('requires messages array', () => {
      const errors = validateIngestConversation({ source: 'test' });
      expect(errors.some(e => e.field === 'messages')).toBe(true);
    });

    it('requires at least one message', () => {
      const errors = validateIngestConversation({ source: 'test', messages: [] });
      expect(errors.some(e => e.field === 'messages')).toBe(true);
    });

    it('validates message role', () => {
      const errors = validateIngestConversation({
        source: 'test',
        messages: [{ role: 'invalid', content: 'hello' }],
      });
      expect(errors.some(e => e.field === 'messages[0].role')).toBe(true);
    });

    it('validates message content', () => {
      const errors = validateIngestConversation({
        source: 'test',
        messages: [{ role: 'user' }],
      });
      expect(errors.some(e => e.field === 'messages[0].content')).toBe(true);
    });

    it('rejects non-object body', () => {
      const errors = validateIngestConversation('not an object');
      expect(errors.some(e => e.field === 'body')).toBe(true);
    });
  });

  describe('validateAppendMessage', () => {
    it('returns no errors for valid input', () => {
      const errors = validateAppendMessage({
        conversationId: 'abc-123',
        role: 'user',
        content: 'hello',
      });
      expect(errors).toHaveLength(0);
    });

    it('requires conversationId', () => {
      const errors = validateAppendMessage({ role: 'user', content: 'hello' });
      expect(errors.some(e => e.field === 'conversationId')).toBe(true);
    });

    it('requires valid role', () => {
      const errors = validateAppendMessage({
        conversationId: 'abc',
        role: 'invalid',
        content: 'hello',
      });
      expect(errors.some(e => e.field === 'role')).toBe(true);
    });
  });

  describe('validateRecallRequest', () => {
    it('returns no errors for valid input', () => {
      const errors = validateRecallRequest({ query: 'what did we discuss?' });
      expect(errors).toHaveLength(0);
    });

    it('requires query field', () => {
      const errors = validateRecallRequest({});
      expect(errors.some(e => e.field === 'query')).toBe(true);
    });

    it('rejects empty query', () => {
      const errors = validateRecallRequest({ query: '   ' });
      expect(errors.some(e => e.field === 'query')).toBe(true);
    });

    it('validates maxResults range', () => {
      const errors = validateRecallRequest({ query: 'test', maxResults: 200 });
      expect(errors.some(e => e.field === 'maxResults')).toBe(true);
    });

    it('validates minScore range', () => {
      const errors = validateRecallRequest({ query: 'test', minScore: 1.5 });
      expect(errors.some(e => e.field === 'minScore')).toBe(true);
    });

    it('validates vectorWeight range', () => {
      const errors = validateRecallRequest({ query: 'test', vectorWeight: -0.1 });
      expect(errors.some(e => e.field === 'vectorWeight')).toBe(true);
    });
  });
});

// ─── Router Integration Tests ────────────────────────────

describe('REST API Router', () => {
  let db: Database.Database;
  let ingestService: IngestService;
  let app: Hono;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    const repo = new ConversationRepository(db);
    ingestService = new IngestService(repo);

    const deps: RouterDependencies = {
      ingestService,
      // No retriever — recall will return 503
    };
    app = createRouter(deps);
  });

  afterEach(() => {
    db.close();
  });

  // ── Health ──

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const res = await request(app, 'GET', '/health');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe('ok');
      expect(body.version).toBeDefined();
      expect(body.timestamp).toBeDefined();
    });
  });

  // ── POST /ingest ──

  describe('POST /ingest', () => {
    it('ingests a conversation and returns 201', async () => {
      const res = await request(app, 'POST', '/ingest', {
        source: 'claude-code',
        title: 'Test Chat',
        messages: [
          { role: 'user', content: 'Hello!' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      expect(res.status).toBe(201);
      const body = await res.json() as Record<string, unknown>;
      expect(body.conversationId).toBeDefined();
      expect(body.messageCount).toBe(2);
      expect(body.createdAt).toBeDefined();
      expect(body.updatedAt).toBeDefined();
    });

    it('returns 400 for missing source', async () => {
      const res = await request(app, 'POST', '/ingest', {
        messages: [{ role: 'user', content: 'Hello!' }],
      });
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for empty messages', async () => {
      const res = await request(app, 'POST', '/ingest', {
        source: 'test',
        messages: [],
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid role in messages', async () => {
      const res = await request(app, 'POST', '/ingest', {
        source: 'test',
        messages: [{ role: 'invalid', content: 'Hello!' }],
      });
      expect(res.status).toBe(400);
    });

    it('persists conversation data via IngestService', async () => {
      const res = await request(app, 'POST', '/ingest', {
        source: 'codex',
        messages: [
          { role: 'user', content: 'Explain TypeScript' },
          { role: 'assistant', content: 'TypeScript is...' },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json() as Record<string, unknown>;

      // Verify conversation was actually stored
      const conv = ingestService.getConversation(body.conversationId as string);
      expect(conv).not.toBeNull();
      expect(conv!.messages).toHaveLength(2);
      expect(conv!.source).toBe('codex');
    });

    it('accepts optional metadata', async () => {
      const res = await request(app, 'POST', '/ingest', {
        source: 'test',
        messages: [{ role: 'user', content: 'Hello!', metadata: { tokens: 5 } }],
        metadata: { model: 'claude-3.5' },
      });
      expect(res.status).toBe(201);
    });
  });

  // ── POST /ingest/append ──

  describe('POST /ingest/append', () => {
    it('appends a message and returns 201', async () => {
      // First create a conversation
      const ingestRes = await request(app, 'POST', '/ingest', {
        source: 'test',
        messages: [{ role: 'user', content: 'Hello!' }],
      });
      const { conversationId } = await ingestRes.json() as Record<string, unknown>;

      // Append a message
      const res = await request(app, 'POST', '/ingest/append', {
        conversationId,
        role: 'assistant',
        content: 'Hi there!',
      });

      expect(res.status).toBe(201);
      const body = await res.json() as Record<string, unknown>;
      expect(body.conversationId).toBe(conversationId);
      expect(body.turnIndex).toBe(1);
      expect(body.createdAt).toBeDefined();
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await request(app, 'POST', '/ingest/append', {
        conversationId: 'non-existent-id',
        role: 'user',
        content: 'Hello!',
      });
      expect(res.status).toBe(404);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('NOT_FOUND');
    });

    it('returns 400 for missing fields', async () => {
      const res = await request(app, 'POST', '/ingest/append', {
        role: 'user',
        content: 'Hello!',
      });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /recall ──

  describe('POST /recall', () => {
    it('returns 503 when retriever is not configured', async () => {
      const res = await request(app, 'POST', '/recall', {
        query: 'What did we discuss?',
      });
      expect(res.status).toBe(503);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('SERVICE_UNAVAILABLE');
    });

    it('returns 400 for missing query', async () => {
      const res = await request(app, 'POST', '/recall', {});
      expect(res.status).toBe(400);
    });

    it('returns 400 for empty query', async () => {
      const res = await request(app, 'POST', '/recall', { query: '   ' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid maxResults', async () => {
      const res = await request(app, 'POST', '/recall', {
        query: 'test',
        maxResults: 0,
      });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /recall with mock retriever ──

  describe('POST /recall with retriever', () => {
    it('returns recall results from the retriever', async () => {
      // Create a mock retriever
      const mockRetriever = {
        async recall(_query: unknown) {
          return {
            items: [
              {
                nodeId: 'fact-1',
                nodeType: 'fact',
                score: 0.85,
                content: 'TypeScript is a typed superset of JavaScript',
                sources: ['vector', 'graph'],
                sourceScores: { vector: 0.9, graph: 0.7 },
              },
            ],
            diagnostics: {
              activatedAnchors: [],
              extractedEntities: ['TypeScript'],
              graphSeedCount: 1,
              vectorTimeMs: 5.2,
              graphTimeMs: 3.1,
              totalTimeMs: 8.5,
              vectorItemCount: 1,
              graphItemCount: 1,
              mergeStats: {
                vectorInputCount: 1,
                graphInputCount: 1,
                overlapCount: 1,
                uniqueCount: 1,
                filteredCount: 1,
                outputCount: 1,
                mergeTimeMs: 0.1,
              },
              edgesReinforced: 0,
              vectorTimedOut: false,
              graphTimedOut: false,
            },
          };
        },
      } as any;

      const appWithRetriever = createRouter({
        ingestService,
        retriever: mockRetriever,
      });

      const res = await request(appWithRetriever, 'POST', '/recall', {
        query: 'What is TypeScript?',
        includeDiagnostics: true,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.totalItems).toBe(1);
      expect(body.query).toBe('What is TypeScript?');

      const items = body.items as any[];
      expect(items[0].nodeId).toBe('fact-1');
      expect(items[0].score).toBe(0.85);
      expect(items[0].content).toBe('TypeScript is a typed superset of JavaScript');
      expect(items[0].sources).toEqual(['vector', 'graph']);

      // Diagnostics should be included
      expect(body.diagnostics).toBeDefined();
    });

    it('omits diagnostics by default', async () => {
      const mockRetriever = {
        async recall() {
          return { items: [], diagnostics: { activatedAnchors: [], extractedEntities: [], graphSeedCount: 0, vectorTimeMs: 0, graphTimeMs: 0, totalTimeMs: 0, vectorItemCount: 0, graphItemCount: 0, mergeStats: { vectorInputCount: 0, graphInputCount: 0, overlapCount: 0, uniqueCount: 0, filteredCount: 0, outputCount: 0, mergeTimeMs: 0 }, edgesReinforced: 0, vectorTimedOut: false, graphTimedOut: false } };
        },
      } as any;

      const appWithRetriever = createRouter({
        ingestService,
        retriever: mockRetriever,
      });

      const res = await request(appWithRetriever, 'POST', '/recall', {
        query: 'test query',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.diagnostics).toBeUndefined();
    });
  });
});
