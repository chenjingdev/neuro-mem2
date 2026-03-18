/**
 * Repository for raw conversation storage.
 * All write operations preserve immutability of existing records.
 *
 * raw_messages uses a turn-based composite PK: (conversation_id, turn_index).
 * This eliminates UUID overhead and enables efficient range queries.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  RawConversation,
  RawMessage,
  IngestConversationInput,
  AppendMessageInput,
} from '../models/conversation.js';

export class ConversationRepository {
  constructor(private db: Database.Database) {}

  /**
   * Ingest a full conversation (with all messages) as immutable records.
   * Returns the stored RawConversation with generated IDs and timestamps.
   */
  ingest(input: IngestConversationInput): RawConversation {
    const now = new Date().toISOString();
    const conversationId = input.id || uuidv4();

    const conversation: RawConversation = {
      id: conversationId,
      title: input.title,
      source: input.source,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
      messages: [],
    };

    const insertConversation = this.db.prepare(`
      INSERT INTO raw_conversations (id, title, source, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertMessage = this.db.prepare(`
      INSERT INTO raw_messages (conversation_id, turn_index, role, content, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      insertConversation.run(
        conversation.id,
        conversation.title ?? null,
        conversation.source,
        conversation.createdAt,
        conversation.updatedAt,
        conversation.metadata ? JSON.stringify(conversation.metadata) : null
      );

      for (let i = 0; i < input.messages.length; i++) {
        const msg = input.messages[i]!;
        const message: RawMessage = {
          conversationId,
          role: msg.role,
          content: msg.content,
          turnIndex: i,
          createdAt: now,
          metadata: msg.metadata,
        };

        insertMessage.run(
          message.conversationId,
          message.turnIndex,
          message.role,
          message.content,
          message.createdAt,
          message.metadata ? JSON.stringify(message.metadata) : null
        );

        conversation.messages.push(message);
      }
    });

    txn();
    return conversation;
  }

  /**
   * Append a single message to an existing conversation.
   * The original messages are never modified — this only adds new records.
   */
  appendMessage(input: AppendMessageInput): RawMessage {
    const now = new Date().toISOString();

    // Get the next turn index
    const lastTurn = this.db.prepare(`
      SELECT MAX(turn_index) as max_turn FROM raw_messages WHERE conversation_id = ?
    `).get(input.conversationId) as { max_turn: number | null } | undefined;

    const nextTurn = (lastTurn?.max_turn ?? -1) + 1;

    const message: RawMessage = {
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      turnIndex: nextTurn,
      createdAt: now,
      metadata: input.metadata,
    };

    const txn = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO raw_messages (conversation_id, turn_index, role, content, created_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        message.conversationId,
        message.turnIndex,
        message.role,
        message.content,
        message.createdAt,
        message.metadata ? JSON.stringify(message.metadata) : null
      );

      // Update conversation's updatedAt
      this.db.prepare(`
        UPDATE raw_conversations SET updated_at = ? WHERE id = ?
      `).run(now, input.conversationId);
    });

    txn();
    return message;
  }

  /**
   * Retrieve a full conversation with all its messages.
   */
  getConversation(conversationId: string): RawConversation | null {
    const row = this.db.prepare(`
      SELECT id, title, source, created_at, updated_at, metadata
      FROM raw_conversations WHERE id = ?
    `).get(conversationId) as {
      id: string; title: string | null; source: string;
      created_at: string; updated_at: string; metadata: string | null;
    } | undefined;

    if (!row) return null;

    const messages = this.getMessages(conversationId);

    return {
      id: row.id,
      title: row.title ?? undefined,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      messages,
    };
  }

  /**
   * Get all messages for a conversation, ordered by turn index.
   */
  getMessages(conversationId: string): RawMessage[] {
    const rows = this.db.prepare(`
      SELECT conversation_id, turn_index, role, content, created_at, metadata
      FROM raw_messages WHERE conversation_id = ? ORDER BY turn_index ASC
    `).all(conversationId) as Array<{
      conversation_id: string; turn_index: number; role: string;
      content: string; created_at: string; metadata: string | null;
    }>;

    return rows.map(r => ({
      conversationId: r.conversation_id,
      turnIndex: r.turn_index,
      role: r.role as RawMessage['role'],
      content: r.content,
      createdAt: r.created_at,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  /**
   * Get a single message by its composite key (conversationId, turnIndex).
   */
  getMessage(conversationId: string, turnIndex: number): RawMessage | null {
    const row = this.db.prepare(`
      SELECT conversation_id, turn_index, role, content, created_at, metadata
      FROM raw_messages WHERE conversation_id = ? AND turn_index = ?
    `).get(conversationId, turnIndex) as {
      conversation_id: string; turn_index: number; role: string;
      content: string; created_at: string; metadata: string | null;
    } | undefined;

    if (!row) return null;

    return {
      conversationId: row.conversation_id,
      turnIndex: row.turn_index,
      role: row.role as RawMessage['role'],
      content: row.content,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  /**
   * List conversations with pagination.
   */
  listConversations(options: { limit?: number; offset?: number; source?: string } = {}): RawConversation[] {
    const { limit = 50, offset = 0, source } = options;

    let query = 'SELECT id, title, source, created_at, updated_at, metadata FROM raw_conversations';
    const params: unknown[] = [];

    if (source) {
      query += ' WHERE source = ?';
      params.push(source);
    }

    query += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: string; title: string | null; source: string;
      created_at: string; updated_at: string; metadata: string | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      title: r.title ?? undefined,
      source: r.source,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      messages: [], // Lazy-loaded; use getConversation for full data
    }));
  }

  /**
   * Count total conversations.
   */
  countConversations(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM raw_conversations').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Count messages in a conversation.
   */
  countMessages(conversationId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM raw_messages WHERE conversation_id = ?').get(conversationId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Check if a conversation exists (lightweight, no data loaded).
   */
  conversationExists(conversationId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM raw_conversations WHERE id = ? LIMIT 1'
    ).get(conversationId);
    return row !== undefined;
  }

  /**
   * Get messages within a turn index range [fromTurn, toTurn] inclusive.
   * Useful for building context windows without loading all messages.
   */
  getMessagesInRange(conversationId: string, fromTurn: number, toTurn: number): RawMessage[] {
    const rows = this.db.prepare(`
      SELECT conversation_id, turn_index, role, content, created_at, metadata
      FROM raw_messages
      WHERE conversation_id = ? AND turn_index >= ? AND turn_index <= ?
      ORDER BY turn_index ASC
    `).all(conversationId, fromTurn, toTurn) as Array<{
      conversation_id: string; turn_index: number; role: string;
      content: string; created_at: string; metadata: string | null;
    }>;

    return rows.map(r => ({
      conversationId: r.conversation_id,
      turnIndex: r.turn_index,
      role: r.role as RawMessage['role'],
      content: r.content,
      createdAt: r.created_at,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  /**
   * Get the N most recent messages for a conversation.
   * Returned in chronological order (oldest first).
   */
  getLatestMessages(conversationId: string, limit: number): RawMessage[] {
    const rows = this.db.prepare(`
      SELECT conversation_id, turn_index, role, content, created_at, metadata
      FROM raw_messages
      WHERE conversation_id = ?
      ORDER BY turn_index DESC
      LIMIT ?
    `).all(conversationId, limit) as Array<{
      conversation_id: string; turn_index: number; role: string;
      content: string; created_at: string; metadata: string | null;
    }>;

    // Reverse to chronological order
    return rows.reverse().map(r => ({
      conversationId: r.conversation_id,
      turnIndex: r.turn_index,
      role: r.role as RawMessage['role'],
      content: r.content,
      createdAt: r.created_at,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  /**
   * Get the highest turn index for a conversation (or -1 if no messages).
   */
  getMaxTurnIndex(conversationId: string): number {
    const row = this.db.prepare(
      'SELECT MAX(turn_index) as max_turn FROM raw_messages WHERE conversation_id = ?'
    ).get(conversationId) as { max_turn: number | null } | undefined;
    return row?.max_turn ?? -1;
  }

  /**
   * Search conversations by title (case-insensitive LIKE).
   */
  searchByTitle(query: string, limit = 20): RawConversation[] {
    const rows = this.db.prepare(`
      SELECT id, title, source, created_at, updated_at, metadata
      FROM raw_conversations
      WHERE title LIKE ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(`%${query}%`, limit) as Array<{
      id: string; title: string | null; source: string;
      created_at: string; updated_at: string; metadata: string | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      title: r.title ?? undefined,
      source: r.source,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      messages: [],
    }));
  }

  /**
   * Get conversations updated within a time range.
   * Useful for incremental processing / sync.
   */
  getConversationsUpdatedSince(since: string, limit = 100): RawConversation[] {
    const rows = this.db.prepare(`
      SELECT id, title, source, created_at, updated_at, metadata
      FROM raw_conversations
      WHERE updated_at > ?
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(since, limit) as Array<{
      id: string; title: string | null; source: string;
      created_at: string; updated_at: string; metadata: string | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      title: r.title ?? undefined,
      source: r.source,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      messages: [],
    }));
  }
}
