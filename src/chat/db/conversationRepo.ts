/**
 * Conversation & Message Repository — persistent storage for debug chat data.
 *
 * Provides CRUD operations for chat_conversations and chat_messages tables.
 * Used by the REST API endpoints (GET /conversations, GET /conversations/:id/messages)
 * and by the chat pipeline to persist conversation turns.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

// ─── Row types matching SQLite tables ────────────────────

export interface ConversationRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  session_id: string | null;
  user_id: string;
  metadata: string | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  turn_index: number;
  created_at: string;
  token_count: number | null;
  duration_ms: number | null;
  model: string | null;
  metadata: string | null;
}

// ─── Domain types returned by query functions ────────────

export interface StoredConversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
  userId: string;
  metadata?: Record<string, unknown>;
  /** Number of messages (populated by list queries) */
  messageCount?: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  turnIndex: number;
  createdAt: string;
  tokenCount?: number;
  durationMs?: number;
  model?: string;
  metadata?: Record<string, unknown>;
}

// ─── Conversation CRUD ───────────────────────────────────

/**
 * Create a new conversation.
 */
export function createConversation(
  db: Database.Database,
  params: {
    id: string;
    title?: string;
    sessionId?: string;
    userId?: string;
    metadata?: Record<string, unknown>;
  },
): StoredConversation {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO chat_conversations (id, title, created_at, updated_at, session_id, user_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.title ?? null,
    now,
    now,
    params.sessionId ?? null,
    params.userId ?? 'debug-user',
    params.metadata ? JSON.stringify(params.metadata) : null,
  );

  return {
    id: params.id,
    title: params.title ?? null,
    createdAt: now,
    updatedAt: now,
    sessionId: params.sessionId ?? null,
    userId: params.userId ?? 'debug-user',
    metadata: params.metadata,
  };
}

/**
 * Get a conversation by ID.
 */
export function getConversation(
  db: Database.Database,
  id: string,
): StoredConversation | null {
  const row = db.prepare(
    'SELECT * FROM chat_conversations WHERE id = ?',
  ).get(id) as ConversationRow | undefined;

  return row ? rowToConversation(row) : null;
}

/**
 * List conversations, ordered by updated_at descending (most recent first).
 * Includes a message count for each conversation.
 */
export function listConversations(
  db: Database.Database,
  options?: { userId?: string; limit?: number; offset?: number },
): StoredConversation[] {
  let sql = `
    SELECT c.*, COUNT(m.id) as message_count
    FROM chat_conversations c
    LEFT JOIN chat_messages m ON m.conversation_id = c.id
  `;
  const params: unknown[] = [];

  if (options?.userId) {
    sql += ' WHERE c.user_id = ?';
    params.push(options.userId);
  }

  sql += ' GROUP BY c.id ORDER BY c.updated_at DESC';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  if (options?.offset) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const rows = db.prepare(sql).all(...params) as (ConversationRow & { message_count: number })[];
  return rows.map((row) => ({
    ...rowToConversation(row),
    messageCount: row.message_count,
  }));
}

/**
 * Update conversation title and/or updated_at.
 */
export function updateConversation(
  db: Database.Database,
  id: string,
  updates: { title?: string; metadata?: Record<string, unknown> },
): boolean {
  const sets: string[] = ['updated_at = datetime(\'now\')'];
  const params: unknown[] = [];

  if (updates.title !== undefined) {
    sets.push('title = ?');
    params.push(updates.title);
  }
  if (updates.metadata !== undefined) {
    sets.push('metadata = ?');
    params.push(JSON.stringify(updates.metadata));
  }

  params.push(id);
  const result = db.prepare(
    `UPDATE chat_conversations SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...params);

  return result.changes > 0;
}

/**
 * Delete a conversation and all its messages/trace events (cascade via repo).
 */
export function deleteConversation(
  db: Database.Database,
  id: string,
): boolean {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM chat_trace_events WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(id);
    const result = db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id);
    return result.changes > 0;
  });
  return txn();
}

// ─── Message CRUD ────────────────────────────────────────

/**
 * Insert a message into a conversation.
 */
export function createMessage(
  db: Database.Database,
  params: {
    id: string;
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    turnIndex: number;
    tokenCount?: number;
    durationMs?: number;
    model?: string;
    metadata?: Record<string, unknown>;
  },
): StoredMessage {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, role, content, turn_index, created_at, token_count, duration_ms, model, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.conversationId,
    params.role,
    params.content,
    params.turnIndex,
    now,
    params.tokenCount ?? null,
    params.durationMs ?? null,
    params.model ?? null,
    params.metadata ? JSON.stringify(params.metadata) : null,
  );

  // Touch conversation updated_at
  db.prepare(
    `UPDATE chat_conversations SET updated_at = ? WHERE id = ?`,
  ).run(now, params.conversationId);

  return {
    id: params.id,
    conversationId: params.conversationId,
    role: params.role,
    content: params.content,
    turnIndex: params.turnIndex,
    createdAt: now,
    tokenCount: params.tokenCount,
    durationMs: params.durationMs,
    model: params.model,
    metadata: params.metadata,
  };
}

/**
 * Get all messages for a conversation, ordered by turn_index ascending.
 */
export function getMessagesByConversation(
  db: Database.Database,
  conversationId: string,
  options?: { limit?: number; offset?: number },
): StoredMessage[] {
  let sql = `
    SELECT * FROM chat_messages
    WHERE conversation_id = ?
    ORDER BY turn_index ASC
  `;
  const params: unknown[] = [conversationId];

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options?.offset) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const rows = db.prepare(sql).all(...params) as MessageRow[];
  return rows.map(rowToMessage);
}

/**
 * Get a single message by ID.
 */
export function getMessage(
  db: Database.Database,
  id: string,
): StoredMessage | null {
  const row = db.prepare(
    'SELECT * FROM chat_messages WHERE id = ?',
  ).get(id) as MessageRow | undefined;

  return row ? rowToMessage(row) : null;
}

// ─── Additional query helpers ─────────────────────────────

/**
 * Get the next turn index for a conversation (max turn_index + 1, or 0 if empty).
 */
export function getNextTurnIndex(
  db: Database.Database,
  conversationId: string,
): number {
  const result = db.prepare(
    `SELECT MAX(turn_index) as max_turn FROM chat_messages WHERE conversation_id = ?`,
  ).get(conversationId) as { max_turn: number | null } | undefined;

  return (result?.max_turn ?? -1) + 1;
}

/**
 * Get the total message count for a conversation.
 */
export function getMessageCount(
  db: Database.Database,
  conversationId: string,
): number {
  const result = db.prepare(
    `SELECT COUNT(*) as count FROM chat_messages WHERE conversation_id = ?`,
  ).get(conversationId) as { count: number };

  return result.count;
}

/**
 * Delete a single message by ID (and its associated trace events).
 * Returns true if the message existed and was deleted.
 */
export function deleteMessage(
  db: Database.Database,
  messageId: string,
): boolean {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM chat_trace_events WHERE message_id = ?').run(messageId);
    const result = db.prepare('DELETE FROM chat_messages WHERE id = ?').run(messageId);
    return result.changes > 0;
  });

  return txn();
}

// ─── Convenience: save a full chat turn ───────────────────

export interface SaveChatTurnParams {
  conversationId: string;
  userMessage: string;
  assistantMessage: string;
  model?: string;
  durationMs?: number;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
}

export interface SaveChatTurnResult {
  userMessageId: string;
  assistantMessageId: string;
  turnIndex: number;
}

/**
 * Save a complete user+assistant turn in a single transaction.
 * Automatically determines the correct turn indices.
 * Returns the IDs of both saved messages.
 */
export function saveChatTurn(
  db: Database.Database,
  params: SaveChatTurnParams,
): SaveChatTurnResult {
  const txn = db.transaction(() => {
    const turnIndex = getNextTurnIndex(db, params.conversationId);

    const userMsg = createMessage(db, {
      id: uuidv4(),
      conversationId: params.conversationId,
      role: 'user',
      content: params.userMessage,
      turnIndex,
    });

    const assistantMsg = createMessage(db, {
      id: uuidv4(),
      conversationId: params.conversationId,
      role: 'assistant',
      content: params.assistantMessage,
      turnIndex: turnIndex + 1,
      model: params.model,
      durationMs: params.durationMs,
      tokenCount: params.tokenCount,
      metadata: params.metadata,
    });

    return {
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsg.id,
      turnIndex,
    };
  });

  return txn();
}

/**
 * Get or create a conversation. If a conversationId is provided and exists, returns it.
 * Otherwise creates a new one (using the provided id or generating a new UUID).
 */
export function getOrCreateConversation(
  db: Database.Database,
  params: { conversationId?: string; sessionId?: string; userId?: string },
): StoredConversation {
  if (params.conversationId) {
    const existing = getConversation(db, params.conversationId);
    if (existing) return existing;
  }

  return createConversation(db, {
    id: params.conversationId ?? uuidv4(),
    sessionId: params.sessionId,
    userId: params.userId ?? 'debug-user',
  });
}

// ─── Internal helpers ────────────────────────────────────

function rowToConversation(row: ConversationRow): StoredConversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionId: row.session_id,
    userId: row.user_id,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

function rowToMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content,
    turnIndex: row.turn_index,
    createdAt: row.created_at,
    tokenCount: row.token_count ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    model: row.model ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}
