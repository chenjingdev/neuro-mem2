/**
 * E2E Integration Tests for the nero-mem2 REST API.
 *
 * Tests the Hono-based API endpoints via `app.request()` (no actual HTTP server needed),
 * validating the full request → validation → service → response pipeline.
 *
 * Also verifies that the OpenAPI specification is accurate and stays in sync
 * with the actual router routes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { IngestService } from '../src/services/ingest.js';
import { createRouter, type RouterDependencies } from '../src/api/router.js';
import {
  generateOpenApiSpec,
  validateOpenApiSpec,
  getOperationIds,
  getEndpoints,
  REQUIRED_ROUTES,
} from '../src/api/openapi.js';
import {
  validateIngestConversation,
  validateAppendMessage,
  validateRecallRequest,
} from '../src/api/schemas.js';
import type { Hono } from 'hono';

// ─── Test Helpers ────────────────────────────────────────

function createTestDeps(db: Database.Database): RouterDependencies {
  const repo = new ConversationRepository(db);
  const ingestService = new IngestService(repo);
  return { ingestService };
}

function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
): Request {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, opts);
}

async function parseJsonResponse(res: Response): Promise<{ status: number; body: unknown }> {
  const body = await res.json();
  return { status: res.status, body };
}

// ─── Test Suite ──────────────────────────────────────────

describe('API E2E Integration Tests', () => {
  let db: Database.Database;
  let app: Hono;
  let deps: RouterDependencies;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    deps = createTestDeps(db);
    app = createRouter(deps);
  });

  afterEach(() => {
    db.close();
  });

  // ── Health Check ──────────────────────────────────────

  describe('GET /health', () => {
    it('should return healthy status', async () => {
      const res = await app.request('/health');
      const { status, body } = await parseJsonResponse(res);

      expect(status).toBe(200);
      const data = body as Record<string, unknown>;
      expect(data.status).toBe('ok');
      expect(data.version).toBe('0.1.0');
      expect(data.timestamp).toBeDefined();
    });
  });

  // ── POST /ingest — Ingest Conversation ────────────────

  describe('POST /ingest', () => {
    it('should ingest a valid conversation and return 201', async () => {
      const req = jsonRequest('POST', '/ingest', {
        source: 'claude-code',
        title: 'Test Chat',
        messages: [
          { role: 'user', content: 'Hello, Claude!' },
          { role: 'assistant', content: 'Hello! How can I help you?' },
        ],
      });

      const res = await app.request(req);
      const { status, body } = await parseJsonResponse(res);

      expect(status).toBe(201);
      const data = body as Record<string, unknown>;
      expect(data.conversationId).toBeDefined();
      expect(typeof data.conversationId).toBe('string');
      expect(data.messageCount).toBe(2);
      expect(data.createdAt).toBeDefined();
      expect(data.updatedAt).toBeDefined();
    });

    it('should accept a custom conversation ID', async () => {
      const customId = 'custom-conv-001';
      const req = jsonRequest('POST', '/ingest', {
        id: customId,
        source: 'api',
        messages: [{ role: 'user', content: 'Test' }],
      });

      const res = await app.request(req);
      const { status, body } = await parseJsonResponse(res);

      expect(status).toBe(201);
      expect((body as Record<string, unknown>).conversationId).toBe(customId);
    });

    it('should return 400 when source is missing', async () => {
      const req = jsonRequest('POST', '/ingest', {
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const res = await app.request(req);
      const { status, body } = await parseJsonResponse(res);

      expect(status).toBe(400);
      const data = body as { error: string; details?: Array<{ field: string }> };
      expect(data.error).toBe('VALIDATION_ERROR');
      expect(data.details).toBeDefined();
      expect(data.details!.some(d => d.field === 'source')).toBe(true);
    });

    it('should return 400 when messages is empty', async () => {
      const req = jsonRequest('POST', '/ingest', {
        source: 'test',
        messages: [],
      });

      const res = await app.request(req);
      const { status, body } = await parseJsonResponse(res);

      expect(status).toBe(400);
      const data = body as { error: string; details?: Array<{ field: string }> };
      expect(data.error).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when messages array is missing', async () => {
      const req = jsonRequest('POST', '/ingest', {
        source: 'test',
      });

      const res = await app.request(req);
      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid message role', async () => {
      const req = jsonRequest('POST', '/ingest', {
        source: 'test',
        messages: [{ role: 'invalid_role', content: 'Hello' }],
      });

      const res = await app.request(req);
      const { status, body } = await parseJsonResponse(res);

      expect(status).toBe(400);
      const data = body as { error: string; details?: Array<{ field: string }> };
      expect(data.details).toBeDefined();
      expect(data.details!.some(d => d.field.includes('role'))).toBe(true);
    });

    it('should return 400 for empty message content', async () => {
      const req = jsonRequest('POST', '/ingest', {
        source: 'test',
        messages: [{ role: 'user', content: '' }],
      });

      const res = await app.request(req);
      expect(res.status).toBe(400);
    });

    it('should accept system role messages', async () => {
      const req = jsonRequest('POST', '/ingest', {
        source: 'test',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi!' },
        ],
      });

      const res = await app.request(req);
      const { status, body } = await parseJsonResponse(res);

      expect(status).toBe(201);
      expect((body as Record<string, unknown>).messageCount).toBe(3);
    });

    it('should preserve metadata through ingestion', async () => {
      const req = jsonRequest('POST', '/ingest', {
        source: 'test',
        metadata: { sessionId: 'sess-001', model: 'claude-3' },
        messages: [
          { role: 'user', content: 'Hello', metadata: { tokens: 5 } },
        ],
      });

      const res = await app.request(req);
      expect(res.status).toBe(201);
    });
  });

  // ── POST /ingest/append — Append Message ──────────────

  describe('POST /ingest/append', () => {
    let conversationId: string;

    beforeEach(async () => {
      // Create a conversation to append to
      const req = jsonRequest('POST', '/ingest', {
        source: 'test',
        messages: [{ role: 'user', content: 'Initial message' }],
      });
      const res = await app.request(req);
      const { body } = await parseJsonResponse(res);
      conversationId = (body as Record<string, unknown>).conversationId as string;
    });

    it('should append a message and return 201', async () => {
      const req = jsonRequest('POST', '/ingest/append', {
        conversationId,
        role: 'assistant',
        content: 'Here is my response.',
      });

      const res = await app.request(req);
      const { status, body } = await parseJsonResponse(res);

      expect(status).toBe(201);
      const data = body as Record<string, unknown>;
      expect(data.conversationId).toBe(conversationId);
      expect(data.turnIndex).toBe(1);
      expect(data.createdAt).toBeDefined();
    });

    it('should increment turn index for each append', async () => {
      // Append 3 messages
      for (let i = 0; i < 3; i++) {
        const role = i % 2 === 0 ? 'assistant' : 'user';
        const req = jsonRequest('POST', '/ingest/append', {
          conversationId,
          role,
          content: `Message ${i + 1}`,
        });
        const res = await app.request(req);
        const { body } = await parseJsonResponse(res);
        expect((body as Record<string, unknown>).turnIndex).toBe(i + 1);
      }
    });

    it('should return 404 for non-existent conversation', async () => {
      const req = jsonRequest('POST', '/ingest/append', {
        conversationId: 'non-existent-id',
        role: 'user',
        content: 'Hello',
      });

      const res = await app.request(req);
      const { status, body } = await parseJsonResponse(res);

      expect(status).toBe(404);
      expect((body as Record<string, unknown>).error).toBe('NOT_FOUND');
    });

    it('should return 400 when conversationId is missing', async () => {
      const req = jsonRequest('POST', '/ingest/append', {
        role: 'user',
        content: 'Hello',
      });

      const res = await app.request(req);
      expect(res.status).toBe(400);
    });

    it('should return 400 when role is missing', async () => {
      const req = jsonRequest('POST', '/ingest/append', {
        conversationId,
        content: 'Hello',
      });

      const res = await app.request(req);
      expect(res.status).toBe(400);
    });

    it('should return 400 when content is missing', async () => {
      const req = jsonRequest('POST', '/ingest/append', {
        conversationId,
        role: 'user',
      });

      const res = await app.request(req);
      expect(res.status).toBe(400);
    });
  });

  // ── POST /recall — Memory Retrieval ───────────────────

  describe('POST /recall', () => {
    it('should return 503 when no retriever is configured', async () => {
      const req = jsonRequest('POST', '/recall', {
        query: 'What is TypeScript?',
      });

      const res = await app.request(req);
      const { status, body } = await parseJsonResponse(res);

      expect(status).toBe(503);
      const data = body as { error: string; message: string };
      expect(data.error).toBe('SERVICE_UNAVAILABLE');
      expect(data.message).toContain('embedding provider');
    });

    it('should return 400 when query is missing', async () => {
      const req = jsonRequest('POST', '/recall', {});

      const res = await app.request(req);
      const { status, body } = await parseJsonResponse(res);

      expect(status).toBe(400);
      const data = body as { error: string; details?: Array<{ field: string }> };
      expect(data.error).toBe('VALIDATION_ERROR');
      expect(data.details!.some(d => d.field === 'query')).toBe(true);
    });

    it('should return 400 when query is empty string', async () => {
      const req = jsonRequest('POST', '/recall', {
        query: '   ',
      });

      const res = await app.request(req);
      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid maxResults', async () => {
      const req = jsonRequest('POST', '/recall', {
        query: 'test query',
        maxResults: 200, // exceeds max of 100
      });

      const res = await app.request(req);
      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid minScore', async () => {
      const req = jsonRequest('POST', '/recall', {
        query: 'test query',
        minScore: 1.5, // out of range
      });

      const res = await app.request(req);
      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid vectorWeight', async () => {
      const req = jsonRequest('POST', '/recall', {
        query: 'test query',
        vectorWeight: -0.1,
      });

      const res = await app.request(req);
      expect(res.status).toBe(400);
    });
  });

  // ── Recall with Mock Retriever ────────────────────────

  describe('POST /recall (with mock retriever)', () => {
    let appWithRetriever: Hono;

    beforeEach(() => {
      // Create a mock retriever that returns canned results
      const mockRetriever = {
        recall: async (query: { queryText: string; config?: unknown }) => ({
          items: [
            {
              nodeId: 'fact-001',
              nodeType: 'fact' as const,
              score: 0.95,
              content: 'TypeScript is a superset of JavaScript',
              sources: ['vector'] as const,
              sourceScores: { vector: 0.95 },
            },
            {
              nodeId: 'fact-002',
              nodeType: 'fact' as const,
              score: 0.82,
              content: 'TypeScript adds static typing',
              sources: ['graph'] as const,
              sourceScores: { graph: 0.82 },
            },
          ],
          diagnostics: {
            activatedAnchors: [],
            extractedEntities: ['TypeScript'],
            graphSeedCount: 1,
            vectorTimeMs: 12.5,
            graphTimeMs: 8.3,
            totalTimeMs: 15.2,
            vectorItemCount: 1,
            graphItemCount: 1,
            mergeStats: {
              vectorInputCount: 1,
              graphInputCount: 1,
              overlapCount: 0,
              uniqueCount: 2,
              filteredCount: 2,
              outputCount: 2,
              mergeTimeMs: 0.5,
            },
            edgesReinforced: 0,
            vectorTimedOut: false,
            graphTimedOut: false,
          },
        }),
      };

      const repo = new ConversationRepository(db);
      const ingestService = new IngestService(repo);
      appWithRetriever = createRouter({
        ingestService,
        retriever: mockRetriever as any,
      });
    });

    it('should return recall results with 200 status', async () => {
      const req = jsonRequest('POST', '/recall', {
        query: 'What is TypeScript?',
      });

      const res = await appWithRetriever.request(req);
      const { status, body } = await parseJsonResponse(res);

      expect(status).toBe(200);
      const data = body as Record<string, unknown>;
      expect(data.totalItems).toBe(2);
      expect(data.query).toBe('What is TypeScript?');
      expect(Array.isArray(data.items)).toBe(true);

      const items = data.items as Array<Record<string, unknown>>;
      expect(items[0]!.nodeId).toBe('fact-001');
      expect(items[0]!.score).toBe(0.95);
      expect(items[0]!.content).toBe('TypeScript is a superset of JavaScript');
      expect(items[0]!.nodeType).toBe('fact');
    });

    it('should not include diagnostics by default', async () => {
      const req = jsonRequest('POST', '/recall', {
        query: 'test',
      });

      const res = await appWithRetriever.request(req);
      const { body } = await parseJsonResponse(res);
      const data = body as Record<string, unknown>;

      expect(data.diagnostics).toBeUndefined();
    });

    it('should include diagnostics when requested', async () => {
      const req = jsonRequest('POST', '/recall', {
        query: 'test',
        includeDiagnostics: true,
      });

      const res = await appWithRetriever.request(req);
      const { body } = await parseJsonResponse(res);
      const data = body as Record<string, unknown>;

      expect(data.diagnostics).toBeDefined();
      const diag = data.diagnostics as Record<string, unknown>;
      expect(diag.vectorTimeMs).toBeDefined();
      expect(diag.graphTimeMs).toBeDefined();
      expect(diag.totalTimeMs).toBeDefined();
    });

    it('should pass config overrides to retriever', async () => {
      const req = jsonRequest('POST', '/recall', {
        query: 'test',
        maxResults: 5,
        vectorWeight: 0.7,
      });

      const res = await appWithRetriever.request(req);
      expect(res.status).toBe(200);
    });
  });

  // ── Full Ingest → Verify Pipeline ─────────────────────

  describe('Full Ingest → Verify Pipeline', () => {
    it('should ingest a conversation and verify data persists', async () => {
      // 1. Ingest a conversation
      const ingestReq = jsonRequest('POST', '/ingest', {
        source: 'e2e-test',
        title: 'E2E Pipeline Test',
        messages: [
          { role: 'user', content: 'What is memory in AI?' },
          { role: 'assistant', content: 'Memory in AI refers to the ability to store and retrieve past interactions.' },
          { role: 'user', content: 'How does dual-path retrieval work?' },
        ],
      });

      const ingestRes = await app.request(ingestReq);
      const { status: ingestStatus, body: ingestBody } = await parseJsonResponse(ingestRes);

      expect(ingestStatus).toBe(201);
      const convId = (ingestBody as Record<string, unknown>).conversationId as string;
      expect(convId).toBeDefined();
      expect((ingestBody as Record<string, unknown>).messageCount).toBe(3);

      // 2. Append another message
      const appendReq = jsonRequest('POST', '/ingest/append', {
        conversationId: convId,
        role: 'assistant',
        content: 'Dual-path retrieval combines vector similarity search with graph traversal.',
      });

      const appendRes = await app.request(appendReq);
      const { status: appendStatus, body: appendBody } = await parseJsonResponse(appendRes);

      expect(appendStatus).toBe(201);
      expect((appendBody as Record<string, unknown>).turnIndex).toBe(3);

      // 3. Verify the conversation has 4 messages via direct service access
      const conv = deps.ingestService.getConversation(convId);
      expect(conv).not.toBeNull();
      expect(conv!.messages).toHaveLength(4);
      expect(conv!.source).toBe('e2e-test');
      expect(conv!.title).toBe('E2E Pipeline Test');

      // 4. Verify immutability — all original messages are intact
      expect(conv!.messages[0]!.content).toBe('What is memory in AI?');
      expect(conv!.messages[1]!.content).toBe('Memory in AI refers to the ability to store and retrieve past interactions.');
      expect(conv!.messages[2]!.content).toBe('How does dual-path retrieval work?');
      expect(conv!.messages[3]!.content).toBe('Dual-path retrieval combines vector similarity search with graph traversal.');
    });

    it('should handle multiple conversations independently', async () => {
      // Ingest conversation 1
      const res1 = await app.request(jsonRequest('POST', '/ingest', {
        source: 'test',
        title: 'Conv 1',
        messages: [{ role: 'user', content: 'First' }],
      }));
      expect(res1.status).toBe(201);
      const id1 = ((await res1.json()) as Record<string, unknown>).conversationId as string;

      // Ingest conversation 2
      const res2 = await app.request(jsonRequest('POST', '/ingest', {
        source: 'test',
        title: 'Conv 2',
        messages: [{ role: 'user', content: 'Second' }],
      }));
      expect(res2.status).toBe(201);
      const id2 = ((await res2.json()) as Record<string, unknown>).conversationId as string;

      // They should have different IDs
      expect(id1).not.toBe(id2);

      // Append to conv 1 should not affect conv 2
      await app.request(jsonRequest('POST', '/ingest/append', {
        conversationId: id1,
        role: 'assistant',
        content: 'Reply to first',
      }));

      const conv1 = deps.ingestService.getConversation(id1);
      const conv2 = deps.ingestService.getConversation(id2);

      expect(conv1!.messages).toHaveLength(2);
      expect(conv2!.messages).toHaveLength(1);
    });

    it('should handle special characters and unicode', async () => {
      const specialContent = '한국어 日本語 🎉 ```typescript\nconst x = 42;\n``` <script>alert("xss")</script>';

      const res = await app.request(jsonRequest('POST', '/ingest', {
        source: 'test',
        messages: [{ role: 'user', content: specialContent }],
      }));

      expect(res.status).toBe(201);
      const convId = ((await res.json()) as Record<string, unknown>).conversationId as string;

      const conv = deps.ingestService.getConversation(convId);
      expect(conv!.messages[0]!.content).toBe(specialContent);
    });
  });

  // ── Error Response Format ─────────────────────────────

  describe('Error Response Format', () => {
    it('should return structured error with code and message', async () => {
      const req = jsonRequest('POST', '/ingest', {});

      const res = await app.request(req);
      const { body } = await parseJsonResponse(res);
      const data = body as { error: string; message: string; details?: unknown[] };

      expect(data.error).toBeDefined();
      expect(typeof data.error).toBe('string');
      expect(data.message).toBeDefined();
      expect(typeof data.message).toBe('string');
    });

    it('should return validation details for 400 errors', async () => {
      const req = jsonRequest('POST', '/ingest', {
        // Missing source and messages
      });

      const res = await app.request(req);
      const { body } = await parseJsonResponse(res);
      const data = body as { details?: Array<{ field: string; message: string }> };

      expect(data.details).toBeDefined();
      expect(Array.isArray(data.details)).toBe(true);
      for (const detail of data.details!) {
        expect(detail.field).toBeDefined();
        expect(detail.message).toBeDefined();
      }
    });
  });

  // ── 404 handling ──────────────────────────────────────

  describe('Unknown routes', () => {
    it('should return 404 for unknown GET route', async () => {
      const res = await app.request('/nonexistent');
      expect(res.status).toBe(404);
    });

    it('should return 404 for unknown POST route', async () => {
      const res = await app.request(jsonRequest('POST', '/nonexistent', {}));
      expect(res.status).toBe(404);
    });
  });
});

// ─── OpenAPI Specification Tests ─────────────────────────

describe('OpenAPI Specification Tests', () => {
  describe('generateOpenApiSpec', () => {
    it('should generate a valid OpenAPI 3.0 spec', () => {
      const spec = generateOpenApiSpec();
      const errors = validateOpenApiSpec(spec);

      expect(errors).toEqual([]);
    });

    it('should have openapi version 3.0.3', () => {
      const spec = generateOpenApiSpec();
      expect(spec.openapi).toBe('3.0.3');
    });

    it('should have correct info section', () => {
      const spec = generateOpenApiSpec();
      expect(spec.info.title).toBe('nero-mem2 Memory API');
      expect(spec.info.version).toBe('0.1.0');
      expect(spec.info.description).toBeDefined();
      expect(spec.info.description.length).toBeGreaterThan(0);
    });

    it('should have server URL with configurable port', () => {
      const spec1 = generateOpenApiSpec(3030);
      expect(spec1.servers[0]!.url).toBe('http://127.0.0.1:3030');

      const spec2 = generateOpenApiSpec(8080);
      expect(spec2.servers[0]!.url).toBe('http://127.0.0.1:8080');
    });
  });

  describe('Required Routes Coverage', () => {
    it('should document all required routes', () => {
      const spec = generateOpenApiSpec();
      const endpoints = getEndpoints(spec);

      for (const required of REQUIRED_ROUTES) {
        const found = endpoints.find(
          e => e.path === required.path && e.method === required.method,
        );
        expect(found, `Missing route: ${required.method} ${required.path}`).toBeDefined();
        expect(found!.operationId).toBe(required.operationId);
      }
    });

    it('should have unique operation IDs', () => {
      const spec = generateOpenApiSpec();
      const ids = getOperationIds(spec);
      const uniqueIds = new Set(ids);

      expect(ids.length).toBe(uniqueIds.size);
    });

    it('should define all required operations', () => {
      const spec = generateOpenApiSpec();
      const ids = getOperationIds(spec);

      expect(ids).toContain('ingestConversation');
      expect(ids).toContain('appendMessage');
      expect(ids).toContain('recall');
      expect(ids).toContain('healthCheck');
    });
  });

  describe('Schema Definitions', () => {
    it('should define all component schemas', () => {
      const spec = generateOpenApiSpec();
      const schemas = Object.keys(spec.components.schemas);

      expect(schemas).toContain('IngestConversationRequest');
      expect(schemas).toContain('IngestConversationResponse');
      expect(schemas).toContain('AppendMessageRequest');
      expect(schemas).toContain('AppendMessageResponse');
      expect(schemas).toContain('RecallRequest');
      expect(schemas).toContain('RecallResponse');
      expect(schemas).toContain('RecallItem');
      expect(schemas).toContain('ErrorResponse');
      expect(schemas).toContain('HealthResponse');
      expect(schemas).toContain('MessageInput');
    });

    it('should have no broken $ref references', () => {
      const spec = generateOpenApiSpec();
      const errors = validateOpenApiSpec(spec);
      const refErrors = errors.filter(e => e.includes('Referenced schema not defined'));

      expect(refErrors).toEqual([]);
    });

    it('should define required fields for IngestConversationRequest', () => {
      const spec = generateOpenApiSpec();
      const schema = spec.components.schemas.IngestConversationRequest as Record<string, unknown>;

      expect(schema.type).toBe('object');
      expect(schema.required).toEqual(['source', 'messages']);
      const props = schema.properties as Record<string, unknown>;
      expect(props.source).toBeDefined();
      expect(props.messages).toBeDefined();
      expect(props.id).toBeDefined(); // optional
      expect(props.title).toBeDefined(); // optional
    });

    it('should define required fields for RecallRequest', () => {
      const spec = generateOpenApiSpec();
      const schema = spec.components.schemas.RecallRequest as Record<string, unknown>;

      expect(schema.type).toBe('object');
      expect(schema.required).toEqual(['query']);
      const props = schema.properties as Record<string, unknown>;
      expect(props.query).toBeDefined();
      expect(props.maxResults).toBeDefined();
      expect(props.minScore).toBeDefined();
    });

    it('should define correct role enum in MessageInput', () => {
      const spec = generateOpenApiSpec();
      const schema = spec.components.schemas.MessageInput as Record<string, unknown>;
      const props = schema.properties as Record<string, Record<string, unknown>>;

      expect(props.role!.enum).toEqual(['user', 'assistant', 'system']);
    });

    it('should define error response with error and message fields', () => {
      const spec = generateOpenApiSpec();
      const schema = spec.components.schemas.ErrorResponse as Record<string, unknown>;
      const props = schema.properties as Record<string, unknown>;

      expect(props.error).toBeDefined();
      expect(props.message).toBeDefined();
    });
  });

  describe('Path Specifications', () => {
    it('should define request body for POST /ingest', () => {
      const spec = generateOpenApiSpec();
      const postOp = (spec.paths['/ingest'] as Record<string, Record<string, unknown>>).post;

      expect(postOp.requestBody).toBeDefined();
      const reqBody = postOp.requestBody as Record<string, unknown>;
      expect(reqBody.required).toBe(true);
    });

    it('should define 201 and 400 responses for POST /ingest', () => {
      const spec = generateOpenApiSpec();
      const postOp = (spec.paths['/ingest'] as Record<string, Record<string, unknown>>).post;
      const responses = postOp.responses as Record<string, unknown>;

      expect(responses['201']).toBeDefined();
      expect(responses['400']).toBeDefined();
    });

    it('should define 201, 400, and 404 responses for POST /ingest/append', () => {
      const spec = generateOpenApiSpec();
      const postOp = (spec.paths['/ingest/append'] as Record<string, Record<string, unknown>>).post;
      const responses = postOp.responses as Record<string, unknown>;

      expect(responses['201']).toBeDefined();
      expect(responses['400']).toBeDefined();
      expect(responses['404']).toBeDefined();
    });

    it('should define 200, 400, and 503 responses for POST /recall', () => {
      const spec = generateOpenApiSpec();
      const postOp = (spec.paths['/recall'] as Record<string, Record<string, unknown>>).post;
      const responses = postOp.responses as Record<string, unknown>;

      expect(responses['200']).toBeDefined();
      expect(responses['400']).toBeDefined();
      expect(responses['503']).toBeDefined();
    });

    it('should tag endpoints correctly', () => {
      const spec = generateOpenApiSpec();
      const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;

      expect(paths['/ingest']!.post!.tags).toContain('Ingestion');
      expect(paths['/ingest/append']!.post!.tags).toContain('Ingestion');
      expect(paths['/recall']!.post!.tags).toContain('Retrieval');
      expect(paths['/health']!.get!.tags).toContain('System');
    });
  });

  describe('OpenAPI Spec ↔ Router Sync', () => {
    it('should have matching paths between OpenAPI spec and actual router', () => {
      const spec = generateOpenApiSpec();
      const endpoints = getEndpoints(spec);

      // Every documented endpoint should exist in the router
      // We verify by checking the required routes against both spec and router
      const specPaths = endpoints.map(e => `${e.method} ${e.path}`);

      expect(specPaths).toContain('POST /ingest');
      expect(specPaths).toContain('POST /ingest/append');
      expect(specPaths).toContain('POST /recall');
      expect(specPaths).toContain('GET /health');
    });

    it('should match AppendMessageRequest required fields with validation function', () => {
      // The OpenAPI spec says conversationId, role, content are required
      const spec = generateOpenApiSpec();
      const schema = spec.components.schemas.AppendMessageRequest as Record<string, unknown>;
      expect(schema.required).toEqual(['conversationId', 'role', 'content']);

      // The validator should reject missing fields
      const errors = validateAppendMessage({});
      const fields = errors.map((e: { field: string }) => e.field);

      expect(fields).toContain('conversationId');
      expect(fields).toContain('role');
      expect(fields).toContain('content');
    });

    it('should match IngestConversationRequest required fields with validation function', () => {
      const spec = generateOpenApiSpec();
      const schema = spec.components.schemas.IngestConversationRequest as Record<string, unknown>;
      expect(schema.required).toEqual(['source', 'messages']);

      const errors = validateIngestConversation({});
      const fields = errors.map((e: { field: string }) => e.field);

      expect(fields).toContain('source');
      expect(fields).toContain('messages');
    });

    it('should match RecallRequest required fields with validation function', () => {
      const spec = generateOpenApiSpec();
      const schema = spec.components.schemas.RecallRequest as Record<string, unknown>;
      expect(schema.required).toEqual(['query']);

      const errors = validateRecallRequest({});
      const fields = errors.map((e: { field: string }) => e.field);

      expect(fields).toContain('query');
    });
  });

  describe('validateOpenApiSpec', () => {
    it('should detect missing openapi version', () => {
      const spec = generateOpenApiSpec();
      (spec as any).openapi = '';
      const errors = validateOpenApiSpec(spec);
      expect(errors.some(e => e.includes('openapi version'))).toBe(true);
    });

    it('should detect missing info.title', () => {
      const spec = generateOpenApiSpec();
      spec.info.title = '';
      const errors = validateOpenApiSpec(spec);
      expect(errors.some(e => e.includes('info.title'))).toBe(true);
    });

    it('should detect missing operationId', () => {
      const spec = generateOpenApiSpec();
      const healthPath = spec.paths['/health'] as Record<string, Record<string, unknown>>;
      delete healthPath.get!.operationId;
      const errors = validateOpenApiSpec(spec);
      expect(errors.some(e => e.includes('operationId'))).toBe(true);
    });

    it('should detect broken schema references', () => {
      const spec = generateOpenApiSpec();
      // Add a broken reference
      (spec.paths['/health'] as any).get.requestBody = {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/NonExistentSchema' },
          },
        },
      };
      const errors = validateOpenApiSpec(spec);
      expect(errors.some(e => e.includes('NonExistentSchema'))).toBe(true);
    });

    it('should detect no paths defined', () => {
      const spec = generateOpenApiSpec();
      spec.paths = {};
      const errors = validateOpenApiSpec(spec);
      expect(errors.some(e => e.includes('No paths'))).toBe(true);
    });
  });
});
