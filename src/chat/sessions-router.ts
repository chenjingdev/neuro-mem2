/**
 * Sessions API Router — Hono endpoints for querying debug chat sessions.
 *
 * Provides a session-oriented view of the chat data, mapping conversations
 * to "sessions" for the Visual Debug Chat App frontend.
 *
 * Endpoints:
 *   GET  /api/sessions          — List all sessions (id, title, createdAt, messageCount)
 *   GET  /api/sessions/:id      — Get a session's full messages + timeline trace events
 *   POST /api/sessions/:id/end  — End a session (mark as ended, trigger nero-mem2 session end)
 */

import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import {
  listConversations,
  getConversation,
  getMessagesByConversation,
  updateConversation,
} from './db/conversationRepo.js';
import {
  getTraceEventsByConversation,
  getTraceTimelineWithData,
} from './db/traceRepo.js';

// ─── Types ───────────────────────────────────────────────

/** Session status values for the debug chat app. */
export type SessionStatus = 'active' | 'ended';

/**
 * Interface for the nero-mem2 SessionManager integration.
 * When provided, ending a debug chat session also triggers
 * the nero-mem2 session lifecycle (batch extraction, etc.).
 */
export interface SessionEndHandler {
  /**
   * End a nero-mem2 session by ID.
   * @param sessionId - The nero-mem2 session ID (from chat_conversations.session_id)
   * @param reason - End reason (typically 'explicit' for user-initiated)
   * @returns The ended session or null if not found / already ended
   */
  endSession(sessionId: string, reason?: string): Promise<unknown>;
}

export interface SessionsRouterDependencies {
  /** The chat database handle (with chat tables applied). */
  db: Database.Database;
  /** Optional nero-mem2 session end handler for lifecycle integration. */
  sessionEndHandler?: SessionEndHandler;
}

/** Session summary returned by GET /api/sessions */
export interface SessionSummary {
  id: string;
  title: string | null;
  createdAt: string;
  messageCount: number;
  status: SessionStatus;
}

/** Full session detail returned by GET /api/sessions/:id */
export interface SessionDetail {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  userId: string;
  status: SessionStatus;
  endedAt: string | null;
  messages: SessionMessage[];
  timeline: SessionTimelineEvent[];
}

/** Response from POST /api/sessions/:id/end */
export interface SessionEndResponse {
  id: string;
  status: SessionStatus;
  endedAt: string;
  neroSessionEnded: boolean;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  turnIndex: number;
  createdAt: string;
  model?: string;
  durationMs?: number;
  tokenCount?: number;
}

export interface SessionTimelineEvent {
  id: number;
  messageId: string;
  traceId: number;
  stage: string;
  status: string;
  parentStage?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  skipReason?: string;
  durationMs?: number;
  timestamp: string;
}

// ─── Router Factory ──────────────────────────────────────

/**
 * Create the Hono sessions router for the Visual Debug Chat App.
 *
 * @param deps - Dependencies (database handle)
 * @returns Hono app with /api/sessions routes
 */
export function createSessionsRouter(deps: SessionsRouterDependencies): Hono {
  const app = new Hono();

  // ── GET /api/sessions — list all sessions ──
  app.get('/api/sessions', (c) => {
    try {
      const limit = parseIntParam(c.req.query('limit'), 50);
      const offset = parseIntParam(c.req.query('offset'), 0);

      const conversations = listConversations(deps.db, { limit, offset });

      const sessions: SessionSummary[] = conversations.map((conv) => ({
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        messageCount: conv.messageCount ?? 0,
        status: getSessionStatus(conv.metadata),
      }));

      return c.json({
        sessions,
        pagination: { limit, offset, count: sessions.length },
      });
    } catch (err) {
      return c.json(
        { error: 'INTERNAL_ERROR', message: errorMessage(err) },
        500,
      );
    }
  });

  // ── GET /api/sessions/:id — get full session detail ──
  app.get('/api/sessions/:id', (c) => {
    try {
      const id = c.req.param('id');
      const conversation = getConversation(deps.db, id);

      if (!conversation) {
        return c.json(
          { error: 'NOT_FOUND', message: `Session ${id} not found` },
          404,
        );
      }

      // Fetch all messages for this conversation
      const storedMessages = getMessagesByConversation(deps.db, id);
      const messages: SessionMessage[] = storedMessages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        turnIndex: msg.turnIndex,
        createdAt: msg.createdAt,
        model: msg.model,
        durationMs: msg.durationMs,
        tokenCount: msg.tokenCount,
      }));

      // Fetch all trace events for this conversation
      const storedTraces = getTraceEventsByConversation(deps.db, id);
      const timeline: SessionTimelineEvent[] = storedTraces.map((trace) => ({
        id: trace.id,
        messageId: trace.messageId,
        traceId: trace.traceId,
        stage: trace.stage,
        status: trace.status,
        parentStage: trace.parentStage,
        input: trace.input,
        output: trace.output,
        error: trace.error,
        skipReason: trace.skipReason,
        durationMs: trace.durationMs,
        timestamp: trace.timestamp,
      }));

      const detail: SessionDetail = {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        userId: conversation.userId,
        status: getSessionStatus(conversation.metadata),
        endedAt: getSessionEndedAt(conversation.metadata),
        messages,
        timeline,
      };

      return c.json(detail);
    } catch (err) {
      return c.json(
        { error: 'INTERNAL_ERROR', message: errorMessage(err) },
        500,
      );
    }
  });

  // ── POST /api/sessions/:id/end — end a session & trigger batch extraction ──
  // :id can be 'current' to end the most recent active session.
  app.post('/api/sessions/:id/end', async (c) => {
    try {
      const rawId = c.req.param('id');
      const conversation = resolveSession(deps.db, rawId);

      if (!conversation) {
        return c.json(
          { error: 'NOT_FOUND', message: rawId === 'current' ? 'No active session found' : `Session ${rawId} not found` },
          404,
        );
      }

      const id = conversation.id;

      // Check if already ended
      const currentStatus = getSessionStatus(conversation.metadata);
      if (currentStatus === 'ended') {
        return c.json(
          { error: 'ALREADY_ENDED', message: `Session ${id} is already ended` },
          409,
        );
      }

      // Parse optional request body
      let reason = 'explicit';
      try {
        const body = await c.req.json();
        if (body && typeof body.reason === 'string') {
          reason = body.reason;
        }
      } catch {
        // No body or invalid JSON — use default reason
      }

      const endedAt = new Date().toISOString();

      // Mark conversation as ended in metadata
      const existingMetadata = conversation.metadata ?? {};
      updateConversation(deps.db, id, {
        metadata: {
          ...existingMetadata,
          status: 'ended',
          endedAt,
          endReason: reason,
        },
      });

      // Trigger nero-mem2 session lifecycle if handler is available
      let neroSessionEnded = false;
      let batchResult: BatchExtractionResult | null = null;

      if (deps.sessionEndHandler && conversation.sessionId) {
        const batchStart = performance.now();
        try {
          const result = await deps.sessionEndHandler.endSession(conversation.sessionId, reason);
          neroSessionEnded = !!result;
          const batchDurationMs = round2(performance.now() - batchStart);

          batchResult = {
            triggered: true,
            sessionId: conversation.sessionId,
            durationMs: batchDurationMs,
            result: result != null ? result : undefined,
          };
        } catch (err) {
          const batchDurationMs = round2(performance.now() - batchStart);
          console.error('[sessions-router] Failed to end nero-mem2 session:', err);
          batchResult = {
            triggered: true,
            sessionId: conversation.sessionId,
            durationMs: batchDurationMs,
            error: errorMessage(err),
          };
          // Non-fatal — the debug chat session is still ended
        }
      }

      const response: SessionEndResponse = {
        id,
        status: 'ended',
        endedAt,
        neroSessionEnded,
      };

      return c.json({
        ...response,
        reason,
        batchExtraction: batchResult ?? { triggered: false, reason: 'No session end handler configured' },
      });
    } catch (err) {
      return c.json(
        { error: 'INTERNAL_ERROR', message: errorMessage(err) },
        500,
      );
    }
  });

  // ── POST /api/sessions/:id/end-stream — end session with SSE trace streaming ──
  // :id can be 'current' to end the most recent active session.
  // Streams batch extraction progress as SSE trace events (episode_extraction, concept_extraction)
  app.post('/api/sessions/:id/end-stream', async (c) => {
    try {
      const rawId = c.req.param('id');
      const conversation = resolveSession(deps.db, rawId);

      if (!conversation) {
        return c.json(
          { error: 'NOT_FOUND', message: rawId === 'current' ? 'No active session found' : `Session ${rawId} not found` },
          404,
        );
      }

      const id = conversation.id;

      // Check if already ended
      if (getSessionStatus(conversation.metadata) === 'ended') {
        return c.json(
          { error: 'ALREADY_ENDED', message: `Session ${id} is already ended` },
          409,
        );
      }

      // Parse optional request body
      let reason = 'explicit';
      try {
        const body = await c.req.json();
        if (body && typeof body.reason === 'string') {
          reason = body.reason;
        }
      } catch {
        // No body or invalid JSON — use default reason
      }

      const sessionId = conversation.sessionId ?? id;
      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const write = (event: string, data: unknown) => {
            const json = typeof data === 'string' ? data : JSON.stringify(data);
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${json}\n\n`));
          };

          (async () => {
            const pipelineStart = performance.now();

            // Emit batch_extraction start trace
            write('trace', {
              stage: 'batch_extraction',
              status: 'start',
              data: {
                sessionId,
                conversationId: id,
                reason,
                jobTypes: ['episode_extraction', 'concept_extraction'],
              },
              timestamp: new Date().toISOString(),
            });

            // Mark conversation as ended
            const endedAt = new Date().toISOString();
            const existingMetadata = conversation.metadata ?? {};
            updateConversation(deps.db, id, {
              metadata: {
                ...existingMetadata,
                status: 'ended',
                endedAt,
                endReason: reason,
              },
            });

            if (!deps.sessionEndHandler) {
              write('trace', {
                stage: 'batch_extraction',
                status: 'skipped',
                data: { reason: 'No session end handler configured' },
                timestamp: new Date().toISOString(),
              });
              write('done', { status: 'ended', sessionId: id, reason, batchExtraction: false });
              controller.close();
              return;
            }

            // Emit episode extraction start
            write('trace', {
              stage: 'episode_extraction',
              status: 'start',
              data: { conversationId: id, sessionId },
              timestamp: new Date().toISOString(),
            });

            // Emit concept extraction start
            write('trace', {
              stage: 'concept_extraction',
              status: 'start',
              data: { conversationId: id, sessionId },
              timestamp: new Date().toISOString(),
            });

            try {
              // Trigger the session end (which triggers batch pipeline internally)
              const extractionStart = performance.now();
              await deps.sessionEndHandler!.endSession(sessionId, reason);
              const extractionDuration = round2(performance.now() - extractionStart);

              // Report episode extraction triggered
              write('trace', {
                stage: 'episode_extraction',
                status: 'complete',
                durationMs: extractionDuration,
                data: { triggered: true, sessionId },
                timestamp: new Date().toISOString(),
              });

              // Report concept extraction triggered
              write('trace', {
                stage: 'concept_extraction',
                status: 'complete',
                durationMs: extractionDuration,
                data: { triggered: true, sessionId },
                timestamp: new Date().toISOString(),
              });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              write('trace', {
                stage: 'episode_extraction',
                status: 'error',
                data: { error: errMsg },
                timestamp: new Date().toISOString(),
              });
              write('trace', {
                stage: 'concept_extraction',
                status: 'error',
                data: { error: errMsg },
                timestamp: new Date().toISOString(),
              });
            }

            // Complete the overall batch extraction
            const totalDuration = round2(performance.now() - pipelineStart);
            write('trace', {
              stage: 'batch_extraction',
              status: 'complete',
              durationMs: totalDuration,
              data: { sessionId, conversationId: id, reason },
              timestamp: new Date().toISOString(),
            });

            write('done', {
              status: 'ended',
              sessionId: id,
              reason,
              batchExtraction: true,
              totalDurationMs: totalDuration,
            });

            controller.close();
          })().catch((err) => {
            try {
              write('trace', {
                stage: 'batch_extraction',
                status: 'error',
                data: { error: err instanceof Error ? err.message : String(err) },
                timestamp: new Date().toISOString(),
              });
              write('done', { status: 'error', error: err instanceof Error ? err.message : String(err) });
              controller.close();
            } catch {
              // Stream may already be closed
            }
          });
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    } catch (err) {
      return c.json(
        { error: 'INTERNAL_ERROR', message: errorMessage(err) },
        500,
      );
    }
  });

  return app;
}

// ─── Types (internal) ─────────────────────────────────────

interface BatchExtractionResult {
  triggered: boolean;
  sessionId: string;
  durationMs: number;
  result?: unknown;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────

function parseIntParam(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve a session ID — supports 'current' as a magic value to find
 * the most recent active (non-ended) conversation.
 */
function resolveSession(db: Database.Database, idOrCurrent: string) {
  if (idOrCurrent === 'current') {
    // Find the most recent active conversation
    const conversations = listConversations(db, { limit: 50, offset: 0 });
    return conversations.find((conv) => getSessionStatus(conv.metadata) !== 'ended') ?? null;
  }
  return getConversation(db, idOrCurrent);
}

function round2(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/**
 * Extract session status from conversation metadata.
 * Conversations with metadata.status === 'ended' are marked ended;
 * all others are active.
 */
function getSessionStatus(metadata?: Record<string, unknown>): SessionStatus {
  if (metadata && metadata['status'] === 'ended') return 'ended';
  return 'active';
}

/**
 * Extract endedAt timestamp from conversation metadata (null if still active).
 */
function getSessionEndedAt(metadata?: Record<string, unknown>): string | null {
  if (metadata && typeof metadata['endedAt'] === 'string') return metadata['endedAt'];
  return null;
}
