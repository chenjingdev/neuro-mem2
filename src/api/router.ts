/**
 * REST API Router — Hono-based HTTP router for nero-mem2.
 *
 * Provides two primary endpoints:
 *   POST /ingest         — Ingest a full conversation
 *   POST /ingest/append  — Append a message to an existing conversation
 *   POST /recall         — Retrieve relevant memories for a query
 *   GET  /health         — Health check endpoint
 *
 * All request bodies are validated before processing.
 * Errors are returned as structured JSON with appropriate HTTP status codes.
 */

import { Hono, type Context } from 'hono';
import type Database from 'better-sqlite3';
import type { IngestService } from '../services/ingest.js';
import type { DualPathRetriever, RecallQuery } from '../retrieval/dual-path-retriever.js';
import {
  validateIngestConversation,
  validateAppendMessage,
  validateRecallRequest,
  validateHybridSearchRequest,
  toIngestInput,
  toAppendInput,
  toRecallResponse,
  type IngestConversationRequest,
  type AppendMessageRequest,
  type RecallRequest,
  type HybridSearchRequest,
  type HybridSearchResponse,
  type IngestResponse,
  type AppendMessageResponse,
  type RecallResponse,
  type ErrorResponse,
} from './schemas.js';
import { ApiKeyStore } from './middleware/api-key-store.js';
import { honoAuth, type HonoAuthOptions } from './middleware/hono-auth.js';
import { honoRateLimit } from './middleware/hono-rate-limit.js';
import { RateLimitStore } from './middleware/rate-limiter.js';
import type { RateLimitConfig } from './middleware/types.js';
import { createChatRouter, type ChatRouterDependencies } from '../chat/chat-router.js';
import { createSessionsRouter } from '../chat/sessions-router.js';
import { createHistoryRouter } from '../chat/history-router.js';
import type { HybridSearcher, HybridSearchConfig } from '../retrieval/hybrid-searcher.js';
import type { MemoryNodeType, MemoryNodeRole } from '../models/memory-node.js';
import { createMemoryNodeRouter, type MemoryNodeRouterDeps } from './memory-node-router.js';
import { createDecaySimulatorRouter, type DecaySimulatorRouterDeps } from './decay-simulator-router.js';

// ─── App Dependencies ────────────────────────────────────

export interface RouterDependencies {
  /** Conversation ingestion service */
  ingestService: IngestService;
  /** Dual-path memory retriever (optional — recall disabled if not provided) */
  retriever?: DualPathRetriever;
  /** SQLite database (needed for API key store; if omitted, auth is disabled) */
  db?: Database.Database;
  /** Pre-built API key store (auto-created from db if not provided) */
  apiKeyStore?: ApiKeyStore;
  /** Auth config: set to false to disable auth entirely (default: enabled if db/apiKeyStore provided) */
  auth?: false | Partial<HonoAuthOptions>;
  /** Rate limit config: set to false to disable rate limiting */
  rateLimit?: false | Partial<RateLimitConfig>;
  /** Rate limit store (shared instance for testing) */
  rateLimitStore?: RateLimitStore;
  /** Chat router dependencies — when provided, mounts the chat router at /chat */
  chatDeps?: ChatRouterDependencies;
  /** Chat debug database handle — when provided, mounts sessions API at /api/sessions */
  chatDb?: Database.Database;
  /** Hybrid searcher (FTS5 + vector) — when provided, enables POST /search/hybrid */
  hybridSearcher?: HybridSearcher;
  /** Memory node router dependencies — when provided, mounts /api/memory-nodes */
  memoryNodeDeps?: MemoryNodeRouterDeps;
  /** Decay simulator router dependencies — when provided, mounts /api/decay-sim */
  decaySimDeps?: DecaySimulatorRouterDeps;
}

// ─── Router Factory ──────────────────────────────────────

/**
 * Create the Hono application with all routes configured.
 *
 * Uses dependency injection so the router is fully testable
 * without needing a real database or LLM provider.
 *
 * When `db` or `apiKeyStore` is provided, authentication middleware
 * is automatically applied. Set `auth: false` to disable.
 */
export function createRouter(deps: RouterDependencies): Hono {
  const app = new Hono();

  // ── Setup API Key Store ──
  const keyStore = deps.apiKeyStore ?? (deps.db ? new ApiKeyStore(deps.db) : undefined);

  // ── Apply global middleware ──

  // Rate limiting (applied first, before auth — protects against brute force)
  if (deps.rateLimit !== false) {
    const store = deps.rateLimitStore ?? new RateLimitStore();
    app.use('*', honoRateLimit(
      typeof deps.rateLimit === 'object' ? deps.rateLimit : undefined,
      store,
    ));
  }

  // Authentication (applied after rate limiting)
  if (deps.auth !== false && keyStore) {
    const authOpts: HonoAuthOptions = {
      keyStore,
      publicPaths: ['/health'],
      ...(typeof deps.auth === 'object' ? deps.auth : {}),
    };
    app.use('*', honoAuth(authOpts));
  }

  // ── Health Check ──
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    });
  });

  // ── POST /ingest — Ingest a full conversation ──
  app.post('/ingest', async (c) => {
    try {
      const body = await c.req.json();

      // Validate request
      const errors = validateIngestConversation(body);
      if (errors.length > 0) {
        const errorResp: ErrorResponse = {
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: errors,
        };
        return c.json(errorResp, 400);
      }

      const input = toIngestInput(body as IngestConversationRequest);
      const conversation = deps.ingestService.ingestConversation(input);

      const response: IngestResponse = {
        conversationId: conversation.id,
        messageCount: conversation.messages.length,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      };

      return c.json(response, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── POST /ingest/append — Append a message to existing conversation ──
  app.post('/ingest/append', async (c) => {
    try {
      const body = await c.req.json();

      const errors = validateAppendMessage(body);
      if (errors.length > 0) {
        const errorResp: ErrorResponse = {
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: errors,
        };
        return c.json(errorResp, 400);
      }

      const input = toAppendInput(body as AppendMessageRequest);
      const message = deps.ingestService.appendMessage(input);

      const response: AppendMessageResponse = {
        conversationId: message.conversationId,
        turnIndex: message.turnIndex,
        createdAt: message.createdAt,
      };

      return c.json(response, 201);
    } catch (err) {
      // Map "Conversation not found" to 404
      if (err instanceof Error && err.message.includes('not found')) {
        const errorResp: ErrorResponse = {
          error: 'NOT_FOUND',
          message: err.message,
        };
        return c.json(errorResp, 404);
      }
      return handleError(c, err);
    }
  });

  // ── Mount Chat Router (Visual Debug Chat App) ──
  // The chat sub-router defines /chat and /chat/health routes.
  // Mounted at /api so endpoints become /api/chat, /api/chat/health.
  // Localhost-only debug use — no auth or rate limiting applied.
  if (deps.chatDeps) {
    const chatRouter = createChatRouter(deps.chatDeps);
    app.route('/api', chatRouter);
  }

  // ── Mount Sessions Router (Visual Debug Chat App — session listing & detail) ──
  // Sessions router defines /api/sessions/* internally, so mount at root.
  // History router defines /conversations/* internally, so mount at /api.
  {
    const sessionsDb = deps.chatDb ?? deps.chatDeps?.chatDb;
    if (sessionsDb) {
      const sessionsRouter = createSessionsRouter({ db: sessionsDb });
      app.route('/', sessionsRouter);

      const historyRouter = createHistoryRouter({ db: sessionsDb });
      app.route('/api', historyRouter);
    }
  }

  // ── Mount Memory Node Router (L0→L1→L2→L3 progressive depth loading) ──
  if (deps.memoryNodeDeps) {
    const memoryNodeRouter = createMemoryNodeRouter(deps.memoryNodeDeps);
    app.route('/api/memory-nodes', memoryNodeRouter);
  }

  // ── Mount Decay Simulator Router ──
  if (deps.decaySimDeps) {
    const decaySimRouter = createDecaySimulatorRouter(deps.decaySimDeps);
    app.route('/api/decay-sim', decaySimRouter);
  }

  // ── POST /search/hybrid — FTS5 + vector hybrid search on MemoryNode ──
  app.post('/search/hybrid', async (c) => {
    try {
      const body = await c.req.json();

      // Validate request
      const errors = validateHybridSearchRequest(body);
      if (errors.length > 0) {
        const errorResp: ErrorResponse = {
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: errors,
        };
        return c.json(errorResp, 400);
      }

      if (!deps.hybridSearcher) {
        const errorResp: ErrorResponse = {
          error: 'SERVICE_UNAVAILABLE',
          message: 'Hybrid search service is not configured. Provide an embedding provider to enable hybrid search.',
        };
        return c.json(errorResp, 503);
      }

      const req = body as HybridSearchRequest;

      // Build config overrides from request
      const configOverrides: Partial<HybridSearchConfig> = {};
      if (req.topK !== undefined) configOverrides.topK = req.topK;
      if (req.minScore !== undefined) configOverrides.minScore = req.minScore;
      if (req.ftsWeight !== undefined) configOverrides.ftsWeight = req.ftsWeight;
      if (req.nodeTypeFilter !== undefined) configOverrides.nodeTypeFilter = req.nodeTypeFilter as MemoryNodeType | MemoryNodeType[];
      if (req.nodeRoleFilter !== undefined) configOverrides.nodeRoleFilter = req.nodeRoleFilter as MemoryNodeRole;
      if (req.applyDecay !== undefined) configOverrides.applyDecay = req.applyDecay;

      const result = await deps.hybridSearcher.search(
        req.query,
        req.currentEventCounter,
        configOverrides,
      );

      const response: HybridSearchResponse = {
        items: result.items.map(item => ({
          nodeId: item.nodeId,
          nodeType: item.nodeType,
          nodeRole: item.nodeRole,
          frontmatter: item.frontmatter,
          score: item.score,
          scoreBreakdown: item.scoreBreakdown,
          source: item.source,
        })),
        totalItems: result.items.length,
        query: req.query,
        stats: (req.includeStats ?? false) ? result.stats as unknown as Record<string, unknown> : undefined,
      };

      return c.json(response, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── POST /recall — Retrieve relevant memories ──
  app.post('/recall', async (c) => {
    try {
      const body = await c.req.json();

      // Validate request first (even if retriever is not configured)
      const errors = validateRecallRequest(body);
      if (errors.length > 0) {
        const errorResp: ErrorResponse = {
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: errors,
        };
        return c.json(errorResp, 400);
      }

      if (!deps.retriever) {
        const errorResp: ErrorResponse = {
          error: 'SERVICE_UNAVAILABLE',
          message: 'Recall service is not configured. Provide an embedding provider to enable recall.',
        };
        return c.json(errorResp, 503);
      }

      const req = body as RecallRequest;

      // Build RecallQuery from request
      const query: RecallQuery = {
        queryText: req.query,
        config: {
          ...req.config,
          ...(req.maxResults !== undefined ? { maxResults: req.maxResults } : {}),
          ...(req.minScore !== undefined ? { minScore: req.minScore } : {}),
          ...(req.vectorWeight !== undefined ? { vectorWeight: req.vectorWeight } : {}),
        },
      };

      const result = await deps.retriever.recall(query);

      const response: RecallResponse = toRecallResponse(
        req.query,
        result,
        req.includeDiagnostics ?? false,
      );

      return c.json(response, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  return app;
}

// ─── Error Handling ──────────────────────────────────────

function handleError(c: Context, err: unknown): Response {
  const message = err instanceof Error ? err.message : 'Internal server error';

  // Log to stderr for debugging (non-blocking)
  console.error('[nero-mem2 API error]', err);

  const errorResp: ErrorResponse = {
    error: 'INTERNAL_ERROR',
    message,
  };
  return c.json(errorResp, 500);
}
