/**
 * History API Router — Hono endpoints for querying stored conversations,
 * messages, and trace events.
 *
 * Endpoints:
 *   GET /conversations               — List all conversations (paginated)
 *   GET /conversations/:id            — Get a single conversation
 *   GET /conversations/:id/messages   — Get messages for a conversation
 *   GET /traces/:conversationId       — Get trace events for a conversation
 *   DELETE /conversations/:id         — Delete a conversation and its data
 */

import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import {
  listConversations,
  getConversation,
  getMessagesByConversation,
  deleteConversation,
} from './db/conversationRepo.js';
import {
  getTraceEventsByConversation,
  getTraceTimeline,
} from './db/traceRepo.js';

// ─── Types ───────────────────────────────────────────────

export interface HistoryRouterDependencies {
  /** The chat database handle (with chat tables applied). */
  db: Database.Database;
}

// ─── Router Factory ──────────────────────────────────────

/**
 * Create the Hono history router for querying stored chat data.
 *
 * @param deps - Dependencies (database handle)
 * @returns Hono app with conversation/message/trace query routes
 */
export function createHistoryRouter(deps: HistoryRouterDependencies): Hono {
  const app = new Hono();

  // ── GET /conversations — list all conversations ──
  app.get('/conversations', (c) => {
    try {
      const userId = c.req.query('userId');
      const limit = parseIntParam(c.req.query('limit'), 50);
      const offset = parseIntParam(c.req.query('offset'), 0);

      const conversations = listConversations(deps.db, {
        userId: userId || undefined,
        limit,
        offset,
      });

      return c.json({
        conversations,
        pagination: { limit, offset, count: conversations.length },
      });
    } catch (err) {
      return c.json(
        { error: 'INTERNAL_ERROR', message: errorMessage(err) },
        500,
      );
    }
  });

  // ── GET /conversations/:id — get a single conversation ──
  app.get('/conversations/:id', (c) => {
    try {
      const id = c.req.param('id');
      const conversation = getConversation(deps.db, id);

      if (!conversation) {
        return c.json(
          { error: 'NOT_FOUND', message: `Conversation ${id} not found` },
          404,
        );
      }

      return c.json({ conversation });
    } catch (err) {
      return c.json(
        { error: 'INTERNAL_ERROR', message: errorMessage(err) },
        500,
      );
    }
  });

  // ── GET /conversations/:id/messages — get messages for a conversation ──
  app.get('/conversations/:id/messages', (c) => {
    try {
      const id = c.req.param('id');
      const limit = parseIntParam(c.req.query('limit'), 200);
      const offset = parseIntParam(c.req.query('offset'), 0);

      // Verify conversation exists
      const conversation = getConversation(deps.db, id);
      if (!conversation) {
        return c.json(
          { error: 'NOT_FOUND', message: `Conversation ${id} not found` },
          404,
        );
      }

      const messages = getMessagesByConversation(deps.db, id, { limit, offset });

      return c.json({
        conversationId: id,
        messages,
        pagination: { limit, offset, count: messages.length },
      });
    } catch (err) {
      return c.json(
        { error: 'INTERNAL_ERROR', message: errorMessage(err) },
        500,
      );
    }
  });

  // ── GET /traces/:conversationId — get trace events for a conversation ──
  app.get('/traces/:conversationId', (c) => {
    try {
      const conversationId = c.req.param('conversationId');
      const format = c.req.query('format'); // 'timeline' for summary

      // Verify conversation exists
      const conversation = getConversation(deps.db, conversationId);
      if (!conversation) {
        return c.json(
          { error: 'NOT_FOUND', message: `Conversation ${conversationId} not found` },
          404,
        );
      }

      const traceEvents = getTraceEventsByConversation(deps.db, conversationId);

      // Optionally compute per-message timelines
      let timelines: Record<string, ReturnType<typeof getTraceTimeline>> | undefined;
      if (format === 'timeline') {
        const messageIds = [...new Set(traceEvents.map((e) => e.messageId))];
        timelines = {};
        for (const msgId of messageIds) {
          timelines[msgId] = getTraceTimeline(deps.db, msgId);
        }
      }

      return c.json({
        conversationId,
        traceEvents,
        ...(timelines ? { timelines } : {}),
      });
    } catch (err) {
      return c.json(
        { error: 'INTERNAL_ERROR', message: errorMessage(err) },
        500,
      );
    }
  });

  // ── DELETE /conversations/:id — delete a conversation and all its data ──
  app.delete('/conversations/:id', (c) => {
    try {
      const id = c.req.param('id');
      const deleted = deleteConversation(deps.db, id);

      if (!deleted) {
        return c.json(
          { error: 'NOT_FOUND', message: `Conversation ${id} not found` },
          404,
        );
      }

      return c.json({ deleted: true, id });
    } catch (err) {
      return c.json(
        { error: 'INTERNAL_ERROR', message: errorMessage(err) },
        500,
      );
    }
  });

  return app;
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
