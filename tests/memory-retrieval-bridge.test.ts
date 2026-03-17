/**
 * Tests for MemoryRetrievalBridge — connecting parsed requests to dual-path retrieval.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { MemoryRetrievalBridge } from '../src/proxy/memory-retrieval-bridge.js';
import { parseRequest } from '../src/proxy/request-parser.js';
import type { ParsedRequest } from '../src/proxy/request-parser.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import type Database from 'better-sqlite3';

// ─── Test Setup ──────────────────────────────────────────

describe('MemoryRetrievalBridge', () => {
  let db: Database.Database;
  let embeddingProvider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    embeddingProvider = new MockEmbeddingProvider(64);
  });

  // ── Skip behavior ──

  describe('skip behavior', () => {
    it('skips retrieval when no user message found', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider);

      const parsed: ParsedRequest = {
        format: 'openai',
        messages: [{ role: 'system', content: 'You are helpful', index: 0 }],
        latestUserMessage: null,
        systemPrompt: 'You are helpful',
        model: 'gpt-4',
        stream: false,
        rawBody: {},
      };

      const result = await bridge.retrieve(parsed);

      expect(result.retrieved).toBe(false);
      expect(result.context).toBeNull();
      expect(result.skipReason).toBe('no_user_message');
    });

    it('skips retrieval when user message is empty', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider);

      const parsed: ParsedRequest = {
        format: 'openai',
        messages: [{ role: 'user', content: '', index: 0 }],
        latestUserMessage: '',
        systemPrompt: null,
        model: 'gpt-4',
        stream: false,
        rawBody: {},
      };

      const result = await bridge.retrieve(parsed);

      expect(result.retrieved).toBe(false);
      expect(result.skipReason).toBe('empty_query');
    });

    it('skips retrieval when user message is whitespace-only', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider);

      const parsed: ParsedRequest = {
        format: 'openai',
        messages: [{ role: 'user', content: '   ', index: 0 }],
        latestUserMessage: '   ',
        systemPrompt: null,
        model: 'gpt-4',
        stream: false,
        rawBody: {},
      };

      const result = await bridge.retrieve(parsed);

      expect(result.retrieved).toBe(false);
      expect(result.skipReason).toBe('empty_query');
    });
  });

  // ── Retrieval execution ──

  describe('retrieval execution', () => {
    it('performs retrieval for valid OpenAI request', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider, {
        retrieverConfig: {
          reinforceOnRetrieval: false,
          pathTimeoutMs: 3000,
        },
      });

      const body = {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Tell me about TypeScript interfaces.' },
        ],
      };

      const parsed = parseRequest(body);
      const result = await bridge.retrieve(parsed);

      expect(result.retrieved).toBe(true);
      expect(result.skipReason).toBeNull();
      expect(result.bridgeTimeMs).toBeGreaterThanOrEqual(0);

      // Even with no data in DB, should still return a result (possibly empty context)
      expect(result.context).toBeDefined();
    });

    it('performs retrieval for Anthropic request', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider, {
        retrieverConfig: {
          reinforceOnRetrieval: false,
          pathTimeoutMs: 3000,
        },
      });

      const body = {
        model: 'claude-3-opus',
        max_tokens: 1024,
        system: 'You are a helpful assistant.',
        messages: [
          { role: 'user', content: 'What is the borrow checker in Rust?' },
        ],
      };

      const parsed = parseRequest(body);
      expect(parsed.format).toBe('anthropic');

      const result = await bridge.retrieve(parsed);

      expect(result.retrieved).toBe(true);
      expect(result.skipReason).toBeNull();
    });

    it('performs retrieval via retrieveByQuery convenience method', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider, {
        retrieverConfig: {
          reinforceOnRetrieval: false,
          pathTimeoutMs: 3000,
        },
      });

      const result = await bridge.retrieveByQuery('How do async iterators work?');

      expect(result.retrieved).toBe(true);
      expect(result.skipReason).toBeNull();
    });
  });

  // ── Context formatting ──

  describe('context formatting', () => {
    it('returns empty context when no memory items found', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider, {
        itemFormat: 'xml',
        retrieverConfig: {
          reinforceOnRetrieval: false,
          pathTimeoutMs: 3000,
        },
      });

      const result = await bridge.retrieveByQuery('A random question with no memory');

      expect(result.retrieved).toBe(true);
      if (result.context) {
        // If retriever returned some items (e.g., from graph path), check format
        expect(typeof result.context.text).toBe('string');
        expect(result.context.itemCount).toBeGreaterThanOrEqual(0);
        expect(result.context.queryText).toBe('A random question with no memory');
      }
    });

    it('includes diagnostics when configured', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider, {
        includeDiagnostics: true,
        retrieverConfig: {
          reinforceOnRetrieval: false,
          pathTimeoutMs: 3000,
        },
      });

      const result = await bridge.retrieveByQuery('Some query');

      expect(result.retrieved).toBe(true);
      expect(result.diagnostics).not.toBeNull();
      if (result.diagnostics) {
        expect(result.diagnostics).toHaveProperty('vectorTimeMs');
        expect(result.diagnostics).toHaveProperty('graphTimeMs');
        expect(result.diagnostics).toHaveProperty('totalTimeMs');
        expect(result.diagnostics).toHaveProperty('vectorItemCount');
        expect(result.diagnostics).toHaveProperty('graphItemCount');
        expect(result.diagnostics).toHaveProperty('mergeStats');
      }
    });

    it('excludes diagnostics by default', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider, {
        retrieverConfig: {
          reinforceOnRetrieval: false,
          pathTimeoutMs: 3000,
        },
      });

      const result = await bridge.retrieveByQuery('Some query');
      expect(result.diagnostics).toBeNull();
    });
  });

  // ── End-to-end: parse → retrieve ──

  describe('end-to-end: parse → retrieve', () => {
    it('chains parseRequest → bridge.retrieve for OpenAI format', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider, {
        retrieverConfig: {
          reinforceOnRetrieval: false,
          pathTimeoutMs: 3000,
        },
      });

      // Simulate an intercepted OpenAI request
      const rawBody = {
        model: 'gpt-4-turbo',
        messages: [
          { role: 'system', content: 'You are a coding assistant.' },
          { role: 'user', content: 'Explain how TypeScript generics work.' },
          { role: 'assistant', content: 'TypeScript generics allow you to...' },
          { role: 'user', content: 'Can you show me an example with constraints?' },
        ],
        temperature: 0.7,
        stream: true,
      };

      // Step 1: Parse the intercepted request
      const parsed = parseRequest(rawBody);
      expect(parsed.format).toBe('openai');
      expect(parsed.latestUserMessage).toBe('Can you show me an example with constraints?');
      expect(parsed.stream).toBe(true);

      // Step 2: Retrieve memory context
      const result = await bridge.retrieve(parsed);
      expect(result.retrieved).toBe(true);
      expect(result.bridgeTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('chains parseRequest → bridge.retrieve for Anthropic format', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider, {
        retrieverConfig: {
          reinforceOnRetrieval: false,
          pathTimeoutMs: 3000,
        },
      });

      const rawBody = {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        system: 'You are a helpful coding assistant.',
        messages: [
          { role: 'user', content: 'I need help with my Rust project.' },
          { role: 'assistant', content: 'Sure, what do you need?' },
          { role: 'user', content: 'How do I implement the Display trait?' },
        ],
        stream: false,
      };

      const parsed = parseRequest(rawBody);
      expect(parsed.format).toBe('anthropic');
      expect(parsed.latestUserMessage).toBe('How do I implement the Display trait?');

      const result = await bridge.retrieve(parsed);
      expect(result.retrieved).toBe(true);
    });
  });

  // ── Config variations ──

  describe('config variations', () => {
    it('respects maxContextItems', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider, {
        maxContextItems: 3,
        retrieverConfig: {
          reinforceOnRetrieval: false,
          pathTimeoutMs: 3000,
        },
      });

      const result = await bridge.retrieveByQuery('test query');
      expect(result.retrieved).toBe(true);
      if (result.context) {
        expect(result.context.itemCount).toBeLessThanOrEqual(3);
      }
    });

    it('respects minContextScore', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider, {
        minContextScore: 0.99, // Very high threshold - should filter almost everything
        retrieverConfig: {
          reinforceOnRetrieval: false,
          pathTimeoutMs: 3000,
        },
      });

      const result = await bridge.retrieveByQuery('test query');
      expect(result.retrieved).toBe(true);
      if (result.context) {
        for (const item of result.context.items) {
          expect(item.score).toBeGreaterThanOrEqual(0.99);
        }
      }
    });

    it('uses plain format', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider, {
        itemFormat: 'plain',
        retrieverConfig: {
          reinforceOnRetrieval: false,
          pathTimeoutMs: 3000,
        },
      });

      const result = await bridge.retrieveByQuery('test');
      expect(result.retrieved).toBe(true);
      // If there are items, plain format should not contain XML tags
      if (result.context && result.context.text.length > 0) {
        expect(result.context.text).not.toContain('<memory-context>');
      }
    });

    it('uses structured format', async () => {
      const bridge = new MemoryRetrievalBridge(db, embeddingProvider, {
        itemFormat: 'structured',
        retrieverConfig: {
          reinforceOnRetrieval: false,
          pathTimeoutMs: 3000,
        },
      });

      const result = await bridge.retrieveByQuery('test');
      expect(result.retrieved).toBe(true);
      if (result.context && result.context.itemCount > 0) {
        expect(result.context.text).toContain('[Memory Context]');
      }
    });
  });
});
