/**
 * Chat API — Hono route integration for the Visual Debug Chat App.
 *
 * This file provides the POST /chat SSE streaming endpoint by mounting
 * the chat router from `src/chat/chat-router.ts` into the existing
 * Hono server infrastructure.
 *
 * It does NOT go through the ProxyServer — it orchestrates the memory
 * pipeline (recall + ingestion) directly and streams results via SSE.
 *
 * SSE Event Protocol:
 *   event: trace  — pipeline stage data (recall, context-build, ingestion)
 *   event: chat   — incremental LLM response tokens (delta / finish / error)
 *   event: done   — terminal event with full response + trace timeline
 *
 * Design:
 *   - localhost only, no authentication
 *   - Single SSE stream per request (Content-Type: text/event-stream)
 *   - ReadableStream-based streaming
 *   - Fixed userId "debug-user"
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type Database from 'better-sqlite3';
import {
  createChatRouter,
  type ChatRouterDependencies,
} from '../chat/chat-router.js';
import { createHistoryRouter } from '../chat/history-router.js';

// ─── Re-exports for convenience ───────────────────────────

export type { ChatRouterDependencies } from '../chat/chat-router.js';
export type {
  ChatRequest,
  TraceEvent,
  ChatEvent,
  DoneEvent,
  IngestionHandler,
} from '../chat/chat-router.js';

// ─── Chat API Factory ─────────────────────────────────────

/**
 * Configuration for the chat API integration.
 */
export interface ChatApiConfig {
  /** Base path prefix for chat routes (default: '/debug') */
  basePath?: string;
  /** Enable CORS for local development (default: true) */
  enableCors?: boolean;
  /** Allowed CORS origins (default: ['http://localhost:5173', 'http://localhost:3000']) */
  corsOrigins?: string[];
  /** Chat database handle — required for history/trace query endpoints */
  chatDb?: Database.Database;
}

const DEFAULT_CHAT_API_CONFIG: Required<Omit<ChatApiConfig, 'chatDb'>> = {
  basePath: '/debug',
  enableCors: true,
  corsOrigins: ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173', 'http://127.0.0.1:3000'],
};

/**
 * Create a Hono app with the chat API routes mounted.
 *
 * This creates a sub-app that can be mounted on the main Hono server:
 *
 * ```ts
 * const mainApp = new Hono();
 * const chatApp = createChatApi(deps);
 * mainApp.route('/debug', chatApp);
 * // → POST /debug/chat, GET /debug/chat/health
 * ```
 *
 * @param deps - Chat router dependencies (LLM provider, retriever, etc.)
 * @param config - Optional configuration
 * @returns Hono app with /chat and /chat/health routes
 */
export function createChatApi(
  deps: ChatRouterDependencies,
  config?: ChatApiConfig,
): Hono {
  const cfg = { ...DEFAULT_CHAT_API_CONFIG, ...config };

  // Create a wrapper app with CORS if enabled
  const app = new Hono();

  if (cfg.enableCors) {
    app.use(
      '*',
      cors({
        origin: cfg.corsOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
        maxAge: 86400,
      }),
    );
  }

  // Mount the chat router (provides POST /chat and GET /chat/health)
  const chatRouter = createChatRouter(deps);
  app.route('/', chatRouter);

  // Mount the history router if a DB handle is provided
  // (provides GET /conversations, GET /conversations/:id/messages, GET /traces/:conversationId)
  if (cfg.chatDb) {
    const historyRouter = createHistoryRouter({ db: cfg.chatDb });
    app.route('/', historyRouter);
  }

  return app;
}

/**
 * Mount the chat API routes on an existing Hono app.
 *
 * Convenience function that creates the chat router and mounts it
 * at the configured base path on the given app.
 *
 * ```ts
 * const app = new Hono();
 * mountChatApi(app, deps);
 * // → POST /debug/chat, GET /debug/chat/health
 * ```
 *
 * @param app - Existing Hono app to mount on
 * @param deps - Chat router dependencies
 * @param config - Optional configuration
 */
export function mountChatApi(
  app: Hono,
  deps: ChatRouterDependencies,
  config?: ChatApiConfig,
): void {
  const cfg = { ...DEFAULT_CHAT_API_CONFIG, ...config };
  const chatApp = createChatApi(deps, config);
  app.route(cfg.basePath, chatApp);
}
