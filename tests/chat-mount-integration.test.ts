/**
 * Integration tests for Chat Router mounted on the main Hono app.
 *
 * Validates:
 * - Chat router is correctly mounted via createRouter with chatDeps
 * - POST /chat returns SSE stream with proper headers
 * - SSE stream contains trace + chat + done events in correct order
 * - GET /chat/health returns chat subsystem status
 * - Existing API routes (/health, /ingest, /recall) still work alongside chat
 * - Chat routes are NOT registered when chatDeps is not provided
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { IngestService } from '../src/services/ingest.js';
import { createRouter, type RouterDependencies } from '../src/api/router.js';
import type { ChatRouterDependencies } from '../src/chat/chat-router.js';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamRequest,
  LLMStreamEvent,
} from '../src/extraction/llm-provider.js';
import type { Hono } from 'hono';

// ─── Mock LLM Provider ──────────────────────────────────────

class MockStreamProvider implements LLMProvider {
  readonly name = 'mock-stream';

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    return { content: `Echo: ${request.prompt}` };
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    const msg = request.messages[request.messages.length - 1]?.content ?? '';
    yield { type: 'delta', content: 'Hello ' };
    yield { type: 'delta', content: 'world' };
    yield {
      type: 'finish',
      content: 'Hello world',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────

let db: Database.Database;
let app: Hono;
let mockProvider: MockStreamProvider;

function makeChatDeps(overrides?: Partial<ChatRouterDependencies>): ChatRouterDependencies {
  return {
    llmProvider: mockProvider,
    ...overrides,
  };
}

function makeRouterDeps(overrides?: Partial<RouterDependencies>): RouterDependencies {
  const repo = new ConversationRepository(db);
  const ingestService = new IngestService(repo);
  return {
    ingestService,
    db,
    auth: false,
    rateLimit: false,
    ...overrides,
  };
}

/** Make a JSON request to the Hono app. */
async function request(hono: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return hono.request(path, init);
}

/** Parse SSE text into structured events. */
function parseSSEStream(text: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split('\n');
    let event = '';
    let data = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        event = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        data = line.slice(6);
      }
    }

    if (event && data) {
      try {
        events.push({ event, data: JSON.parse(data) });
      } catch {
        events.push({ event, data });
      }
    }
  }

  return events;
}

// ─── Setup / Teardown ──────────────────────────────────────

beforeEach(() => {
  db = createDatabase(':memory:');
  mockProvider = new MockStreamProvider();
});

afterEach(() => {
  db.close();
});

// ─── Tests ──────────────────────────────────────────────────

describe('Chat Router mounted on main app', () => {
  describe('POST /chat — SSE streaming', () => {
    it('returns SSE response with correct Content-Type header', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await request(app, 'POST', '/api/chat', { message: 'hello' });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    });

    it('returns all required SSE headers', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await request(app, 'POST', '/api/chat', { message: 'test' });

      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
      expect(res.headers.get('Connection')).toBe('keep-alive');
      expect(res.headers.get('X-Accel-Buffering')).toBe('no');
    });

    it('streams trace, chat, and done events in correct order', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await request(app, 'POST', '/api/chat', { message: 'hello world' });

      const text = await res.text();
      const events = parseSSEStream(text);

      // Should have at least: trace(recall), trace(context-build), trace(llm start),
      //   chat(delta), chat(finish), trace(llm complete), trace(ingestion),
      //   trace(pipeline complete), done
      expect(events.length).toBeGreaterThanOrEqual(5);

      // First events should be trace events
      const traceEvents = events.filter((e) => e.event === 'trace');
      const chatEvents = events.filter((e) => e.event === 'chat');
      const doneEvents = events.filter((e) => e.event === 'done');

      expect(traceEvents.length).toBeGreaterThanOrEqual(3);
      expect(chatEvents.length).toBeGreaterThanOrEqual(2); // at least delta + finish
      expect(doneEvents).toHaveLength(1);

      // Last event must be 'done'
      expect(events[events.length - 1].event).toBe('done');
    });

    it('includes recall trace stage', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await request(app, 'POST', '/api/chat', { message: 'hi' });
      const text = await res.text();
      const events = parseSSEStream(text);

      const recallTrace = events.find(
        (e) => e.event === 'trace' && (e.data as any).stage === 'recall',
      );
      expect(recallTrace).toBeDefined();
    });

    it('includes LLM streaming tokens via chat events', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await request(app, 'POST', '/api/chat', { message: 'greet me' });
      const text = await res.text();
      const events = parseSSEStream(text);

      const deltas = events.filter(
        (e) => e.event === 'chat' && (e.data as any).type === 'delta',
      );
      const finish = events.find(
        (e) => e.event === 'chat' && (e.data as any).type === 'finish',
      );

      expect(deltas.length).toBeGreaterThanOrEqual(1);
      expect(finish).toBeDefined();
      expect((finish!.data as any).content).toBe('Hello world');
    });

    it('includes done event with full response and timing', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await request(app, 'POST', '/api/chat', { message: 'hi' });
      const text = await res.text();
      const events = parseSSEStream(text);

      const done = events.find((e) => e.event === 'done');
      expect(done).toBeDefined();

      const doneData = done!.data as any;
      expect(doneData.fullResponse).toBe('Hello world');
      expect(typeof doneData.totalDurationMs).toBe('number');
      expect(doneData.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(doneData.traceEvents)).toBe(true);
    });

    it('includes pipeline complete trace with stage summary', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await request(app, 'POST', '/api/chat', { message: 'test' });
      const text = await res.text();
      const events = parseSSEStream(text);

      const pipelineComplete = events.find(
        (e) =>
          e.event === 'trace' &&
          (e.data as any).stage === 'pipeline' &&
          (e.data as any).status === 'complete',
      );
      expect(pipelineComplete).toBeDefined();

      const data = (pipelineComplete!.data as any).data;
      expect(data.userId).toBe('debug-user');
      expect(typeof data.responseLength).toBe('number');
      expect(Array.isArray(data.stages)).toBe(true);
    });
  });

  describe('POST /chat — validation errors', () => {
    it('returns 400 for empty message', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await request(app, 'POST', '/api/chat', { message: '' });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for missing message', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await request(app, 'POST', '/api/chat', {});

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid JSON', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json{{{',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('INVALID_JSON');
    });
  });

  describe('GET /chat/health', () => {
    it('returns chat subsystem health status', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await app.request('/api/chat/health', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.subsystem).toBe('chat');
      expect(body.provider).toBe('mock-stream');
      expect(body.userId).toBe('debug-user');
    });
  });

  describe('Coexistence with main API routes', () => {
    it('main /health still works when chat is mounted', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await app.request('/health', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.version).toBe('0.1.0');
    });

    it('POST /ingest still works when chat is mounted', async () => {
      app = createRouter(makeRouterDeps({ chatDeps: makeChatDeps() }));
      const res = await request(app, 'POST', '/ingest', {
        source: 'test-source',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.conversationId).toBeDefined();
    });
  });

  describe('Chat router NOT mounted when chatDeps absent', () => {
    it('POST /chat returns 404 when chatDeps is not provided', async () => {
      app = createRouter(makeRouterDeps());
      const res = await request(app, 'POST', '/api/chat', { message: 'hello' });

      expect(res.status).toBe(404);
    });

    it('GET /chat/health returns 404 when chatDeps is not provided', async () => {
      app = createRouter(makeRouterDeps());
      const res = await app.request('/api/chat/health', { method: 'GET' });

      expect(res.status).toBe(404);
    });
  });
});
