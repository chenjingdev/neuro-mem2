/**
 * Trace Event Repository — persistent storage for pipeline trace events.
 *
 * Stores TraceEvent objects (from TraceCollector) into the chat_trace_events
 * SQLite table, and provides query functions for retrieving trace data
 * by conversation, message, or stage.
 *
 * Also includes a convenience function to create a TraceEventListener
 * that automatically persists events to DB as they are emitted.
 */

import type Database from 'better-sqlite3';
import type { TraceEvent, TraceEventListener, TraceStage, TraceStatus } from '../trace-types.js';

// ─── Row type matching the chat_trace_events table ────────

export interface TraceEventRow {
  id: number;
  conversation_id: string;
  message_id: string;
  trace_id: number;
  stage: string;
  status: string;
  parent_stage: string | null;
  input: string | null;
  output: string | null;
  error: string | null;
  skip_reason: string | null;
  duration_ms: number | null;
  timestamp: string;
}

// ─── Domain type returned by query functions ──────────────

export interface StoredTraceEvent {
  id: number;
  conversationId: string;
  messageId: string;
  traceId: number;
  stage: TraceStage;
  status: TraceStatus;
  parentStage?: TraceStage;
  input?: unknown;
  output?: unknown;
  error?: string;
  skipReason?: string;
  durationMs?: number;
  timestamp: string;
}

// ─── Save functions ───────────────────────────────────────

/**
 * Insert a single trace event into the database.
 */
export function saveTraceEvent(
  db: Database.Database,
  conversationId: string,
  messageId: string,
  event: TraceEvent,
): number {
  const stmt = db.prepare(`
    INSERT INTO chat_trace_events
      (conversation_id, message_id, trace_id, stage, status, parent_stage,
       input, output, error, skip_reason, duration_ms, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    conversationId,
    messageId,
    event.id,
    event.stage,
    event.status,
    event.parentStage ?? null,
    event.input !== undefined ? JSON.stringify(event.input) : null,
    event.output !== undefined ? JSON.stringify(event.output) : null,
    event.error ?? null,
    event.skipReason ?? null,
    event.durationMs ?? null,
    event.timestamp,
  );

  return result.lastInsertRowid as number;
}

/**
 * Insert multiple trace events in a single transaction.
 */
export function saveTraceEvents(
  db: Database.Database,
  conversationId: string,
  messageId: string,
  events: ReadonlyArray<TraceEvent>,
): number[] {
  const ids: number[] = [];

  const stmt = db.prepare(`
    INSERT INTO chat_trace_events
      (conversation_id, message_id, trace_id, stage, status, parent_stage,
       input, output, error, skip_reason, duration_ms, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    for (const event of events) {
      const result = stmt.run(
        conversationId,
        messageId,
        event.id,
        event.stage,
        event.status,
        event.parentStage ?? null,
        event.input !== undefined ? JSON.stringify(event.input) : null,
        event.output !== undefined ? JSON.stringify(event.output) : null,
        event.error ?? null,
        event.skipReason ?? null,
        event.durationMs ?? null,
        event.timestamp,
      );
      ids.push(result.lastInsertRowid as number);
    }
  });

  txn();
  return ids;
}

// ─── Query functions ──────────────────────────────────────

/**
 * Get all trace events for a specific message, ordered by trace_id.
 */
export function getTraceEventsByMessage(
  db: Database.Database,
  messageId: string,
): StoredTraceEvent[] {
  const rows = db.prepare(`
    SELECT * FROM chat_trace_events
    WHERE message_id = ?
    ORDER BY trace_id ASC
  `).all(messageId) as TraceEventRow[];

  return rows.map(rowToStoredEvent);
}

/**
 * Get all trace events for a conversation, ordered by id.
 */
export function getTraceEventsByConversation(
  db: Database.Database,
  conversationId: string,
): StoredTraceEvent[] {
  const rows = db.prepare(`
    SELECT * FROM chat_trace_events
    WHERE conversation_id = ?
    ORDER BY id ASC
  `).all(conversationId) as TraceEventRow[];

  return rows.map(rowToStoredEvent);
}

/**
 * Get trace events filtered by stage (across all conversations).
 */
export function getTraceEventsByStage(
  db: Database.Database,
  stage: string,
  options?: { status?: TraceStatus; limit?: number },
): StoredTraceEvent[] {
  let sql = `SELECT * FROM chat_trace_events WHERE stage = ?`;
  const params: unknown[] = [stage];

  if (options?.status) {
    sql += ` AND status = ?`;
    params.push(options.status);
  }

  sql += ` ORDER BY id DESC`;

  if (options?.limit) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params) as TraceEventRow[];
  return rows.map(rowToStoredEvent);
}

/**
 * Get a timeline summary for a specific message — one row per terminal stage event.
 */
export function getTraceTimeline(
  db: Database.Database,
  messageId: string,
): Array<{
  stage: string;
  status: string;
  durationMs?: number;
  parentStage?: string;
}> {
  const rows = db.prepare(`
    SELECT stage, status, duration_ms, parent_stage
    FROM chat_trace_events
    WHERE message_id = ? AND status != 'start'
    ORDER BY trace_id ASC
  `).all(messageId) as Pick<TraceEventRow, 'stage' | 'status' | 'duration_ms' | 'parent_stage'>[];

  // Keep only the last terminal event per stage
  const seen = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    seen.set(row.stage, row);
  }

  return Array.from(seen.values()).map(row => ({
    stage: row.stage,
    status: row.status,
    durationMs: row.duration_ms ?? undefined,
    parentStage: row.parent_stage ?? undefined,
  }));
}

/**
 * Delete all trace events for a conversation.
 */
export function deleteTraceEventsByConversation(
  db: Database.Database,
  conversationId: string,
): number {
  const result = db.prepare(
    `DELETE FROM chat_trace_events WHERE conversation_id = ?`,
  ).run(conversationId);
  return result.changes;
}

// ─── Listener factory ─────────────────────────────────────

/**
 * Create a TraceEventListener that persists events to the database.
 *
 * Use with TraceCollector.onEvent() to automatically save trace data
 * as the pipeline executes:
 *
 *   const listener = createPersistingListener(db, conversationId, messageId);
 *   const unsub = collector.onEvent(listener);
 *   // ... run pipeline ...
 *   unsub();
 */
export function createPersistingListener(
  db: Database.Database,
  conversationId: string,
  messageId: string,
): TraceEventListener {
  return (event: TraceEvent) => {
    try {
      saveTraceEvent(db, conversationId, messageId, event);
    } catch (err) {
      console.error('[traceRepo] Failed to persist trace event:', err);
    }
  };
}

// ─── Pipeline Trace Persistence (chat-router bridge) ─────

/**
 * Shape of a trace event as collected by the chat-router's SSEWriter/TraceCollector.
 * This is the "SSE format" — a simpler shape than the detailed TraceEvent from trace-types.
 */
export interface PipelineTraceEvent {
  stage: string;
  status: 'start' | 'complete' | 'error' | 'skipped';
  durationMs?: number;
  data?: unknown;
  timestamp: string;
}

/**
 * Convert chat-router PipelineTraceEvents into the DB-compatible TraceEvent format
 * and persist them in a single transaction.
 *
 * This bridges the gap between the SSE trace format (used by chat-router) and
 * the detailed trace format stored in chat_trace_events.
 *
 * Each PipelineTraceEvent.data is decomposed into input/output/error/skipReason
 * based on the event status:
 *   - status:'start'   → data stored as `input`
 *   - status:'complete' → data stored as `output`
 *   - status:'error'   → data.error extracted as `error`, rest as `output`
 *   - status:'skipped' → data.reason extracted as `skip_reason`
 *
 * @param db - Database handle
 * @param conversationId - Chat conversation ID
 * @param messageId - Chat message ID (the assistant response)
 * @param events - Collected pipeline trace events from the chat-router
 * @returns Array of inserted row IDs
 */
export function savePipelineTraceEvents(
  db: Database.Database,
  conversationId: string,
  messageId: string,
  events: ReadonlyArray<PipelineTraceEvent>,
): number[] {
  const ids: number[] = [];

  const stmt = db.prepare(`
    INSERT INTO chat_trace_events
      (conversation_id, message_id, trace_id, stage, status, parent_stage,
       input, output, error, skip_reason, duration_ms, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      const decomposed = decomposeEventData(event);

      const result = stmt.run(
        conversationId,
        messageId,
        i + 1,  // monotonic trace_id (1-based)
        event.stage,
        event.status,
        decomposed.parentStage ?? null,
        decomposed.input !== undefined ? JSON.stringify(decomposed.input) : null,
        decomposed.output !== undefined ? JSON.stringify(decomposed.output) : null,
        decomposed.error ?? null,
        decomposed.skipReason ?? null,
        event.durationMs ?? null,
        event.timestamp,
      );
      ids.push(result.lastInsertRowid as number);
    }
  });

  txn();
  return ids;
}

/**
 * Get a detailed timeline for a message, including stage data payloads.
 * Returns all events (not just terminal ones) for full timeline rendering.
 */
export function getTraceTimelineWithData(
  db: Database.Database,
  messageId: string,
): StoredTraceEvent[] {
  const rows = db.prepare(`
    SELECT * FROM chat_trace_events
    WHERE message_id = ?
    ORDER BY trace_id ASC, id ASC
  `).all(messageId) as TraceEventRow[];

  return rows.map(rowToStoredEvent);
}

/**
 * Get trace event statistics for a conversation — useful for dashboard views.
 */
export function getTraceStats(
  db: Database.Database,
  conversationId: string,
): {
  totalEvents: number;
  byStage: Record<string, number>;
  byStatus: Record<string, number>;
  avgDurationByStage: Record<string, number>;
} {
  const totalRow = db.prepare(
    'SELECT COUNT(*) as cnt FROM chat_trace_events WHERE conversation_id = ?',
  ).get(conversationId) as { cnt: number };

  const stageRows = db.prepare(
    'SELECT stage, COUNT(*) as cnt FROM chat_trace_events WHERE conversation_id = ? GROUP BY stage',
  ).all(conversationId) as { stage: string; cnt: number }[];

  const statusRows = db.prepare(
    'SELECT status, COUNT(*) as cnt FROM chat_trace_events WHERE conversation_id = ? GROUP BY status',
  ).all(conversationId) as { status: string; cnt: number }[];

  const durationRows = db.prepare(`
    SELECT stage, AVG(duration_ms) as avg_ms
    FROM chat_trace_events
    WHERE conversation_id = ? AND duration_ms IS NOT NULL
    GROUP BY stage
  `).all(conversationId) as { stage: string; avg_ms: number }[];

  const byStage: Record<string, number> = {};
  for (const r of stageRows) byStage[r.stage] = r.cnt;

  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = r.cnt;

  const avgDurationByStage: Record<string, number> = {};
  for (const r of durationRows) avgDurationByStage[r.stage] = Math.round(r.avg_ms * 100) / 100;

  return {
    totalEvents: totalRow.cnt,
    byStage,
    byStatus,
    avgDurationByStage,
  };
}

// ─── Internal helpers ─────────────────────────────────────

/**
 * Decompose a PipelineTraceEvent's `data` field into the structured
 * input/output/error/skipReason fields expected by the DB schema.
 */
function decomposeEventData(event: PipelineTraceEvent): {
  input?: unknown;
  output?: unknown;
  error?: string;
  skipReason?: string;
  parentStage?: string;
} {
  const data = event.data as Record<string, unknown> | undefined;

  if (!data) {
    return {};
  }

  switch (event.status) {
    case 'start':
      return { input: data };

    case 'complete':
      return { output: data };

    case 'error': {
      const errorStr = typeof data['error'] === 'string' ? data['error'] : undefined;
      // Store the rest as output for debugging context
      const { error: _err, ...rest } = data;
      return {
        error: errorStr,
        output: Object.keys(rest).length > 0 ? rest : undefined,
      };
    }

    case 'skipped': {
      const reason = typeof data['reason'] === 'string' ? data['reason'] : undefined;
      const { reason: _reason, ...rest } = data;
      return {
        skipReason: reason,
        output: Object.keys(rest).length > 0 ? rest : undefined,
      };
    }

    default:
      return { output: data };
  }
}

function rowToStoredEvent(row: TraceEventRow): StoredTraceEvent {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    traceId: row.trace_id,
    stage: row.stage as TraceStage,
    status: row.status as TraceStatus,
    parentStage: (row.parent_stage as TraceStage) ?? undefined,
    input: row.input ? JSON.parse(row.input) : undefined,
    output: row.output ? JSON.parse(row.output) : undefined,
    error: row.error ?? undefined,
    skipReason: row.skip_reason ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    timestamp: row.timestamp,
  };
}
