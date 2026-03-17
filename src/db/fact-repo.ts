/**
 * Repository for storing and retrieving extracted Facts.
 * Uses the `facts` table directly — no separate memory_nodes indirection.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Fact, CreateFactInput, UpdateFactInput, FactCategory } from '../models/fact.js';

/** Row shape returned from the facts table */
interface FactRow {
  id: string;
  conversation_id: string;
  source_message_ids: string;
  source_turn_index: number;
  content: string;
  category: string;
  confidence: number;
  entities: string;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  superseded: number;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  metadata: string | null;
}

/** Convert a DB row to a Fact domain object */
function rowToFact(row: FactRow): Fact {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sourceMessageIds: JSON.parse(row.source_message_ids),
    sourceTurnIndex: row.source_turn_index,
    content: row.content,
    category: row.category as FactCategory,
    confidence: row.confidence,
    entities: JSON.parse(row.entities),
    subject: row.subject ?? undefined,
    predicate: row.predicate ?? undefined,
    object: row.object ?? undefined,
    superseded: row.superseded === 1,
    supersededBy: row.superseded_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

export class FactRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a single fact from a CreateFactInput.
   * Returns the persisted Fact with generated ID and timestamps.
   */
  create(input: CreateFactInput): Fact {
    const id = uuidv4();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO facts (
        id, conversation_id, source_message_ids, source_turn_index,
        content, category, confidence, entities,
        subject, predicate, object,
        superseded, superseded_by,
        created_at, updated_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
    `).run(
      id,
      input.conversationId,
      JSON.stringify(input.sourceMessageIds),
      input.sourceTurnIndex,
      input.content,
      input.category,
      input.confidence,
      JSON.stringify(input.entities),
      input.subject ?? null,
      input.predicate ?? null,
      input.object ?? null,
      now,
      now,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );

    return {
      id,
      conversationId: input.conversationId,
      sourceMessageIds: input.sourceMessageIds,
      sourceTurnIndex: input.sourceTurnIndex,
      content: input.content,
      category: input.category,
      confidence: input.confidence,
      entities: input.entities,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      superseded: false,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };
  }

  /**
   * Create multiple facts in a single transaction.
   */
  createMany(inputs: CreateFactInput[]): Fact[] {
    if (inputs.length === 0) return [];

    const facts: Fact[] = [];
    const txn = this.db.transaction(() => {
      for (const input of inputs) {
        facts.push(this.create(input));
      }
    });

    txn();
    return facts;
  }

  /**
   * Update an existing fact (confidence, category, supersession, metadata).
   */
  update(factId: string, input: UpdateFactInput): Fact | null {
    const existing = this.getById(factId);
    if (!existing) return null;

    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (input.confidence !== undefined) {
      sets.push('confidence = ?');
      params.push(input.confidence);
    }
    if (input.category !== undefined) {
      sets.push('category = ?');
      params.push(input.category);
    }
    if (input.superseded !== undefined) {
      sets.push('superseded = ?');
      params.push(input.superseded ? 1 : 0);
    }
    if (input.supersededBy !== undefined) {
      sets.push('superseded_by = ?');
      params.push(input.supersededBy);
    }
    if (input.metadata !== undefined) {
      const mergedMeta = { ...existing.metadata, ...input.metadata };
      sets.push('metadata = ?');
      params.push(JSON.stringify(mergedMeta));
    }

    params.push(factId);
    this.db.prepare(`UPDATE facts SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    return this.getById(factId);
  }

  /**
   * Mark a fact as superseded by another fact.
   */
  supersede(oldFactId: string, newFactId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE facts SET superseded = 1, superseded_by = ?, updated_at = ? WHERE id = ?
    `).run(newFactId, now, oldFactId);
  }

  /**
   * Get a single fact by ID.
   */
  getById(factId: string): Fact | null {
    const row = this.db.prepare(
      'SELECT * FROM facts WHERE id = ?'
    ).get(factId) as FactRow | undefined;

    return row ? rowToFact(row) : null;
  }

  /**
   * Get all active (non-superseded) facts for a conversation.
   */
  getActiveByConversation(conversationId: string): Fact[] {
    const rows = this.db.prepare(`
      SELECT * FROM facts
      WHERE conversation_id = ? AND superseded = 0
      ORDER BY source_turn_index ASC, created_at ASC
    `).all(conversationId) as FactRow[];

    return rows.map(rowToFact);
  }

  /**
   * Get all facts for a conversation (including superseded).
   */
  getAllByConversation(conversationId: string): Fact[] {
    const rows = this.db.prepare(`
      SELECT * FROM facts
      WHERE conversation_id = ?
      ORDER BY source_turn_index ASC, created_at ASC
    `).all(conversationId) as FactRow[];

    return rows.map(rowToFact);
  }

  /**
   * Get facts by source turn index.
   */
  getByTurn(conversationId: string, turnIndex: number): Fact[] {
    const rows = this.db.prepare(`
      SELECT * FROM facts
      WHERE conversation_id = ? AND source_turn_index = ?
      ORDER BY created_at ASC
    `).all(conversationId, turnIndex) as FactRow[];

    return rows.map(rowToFact);
  }

  /**
   * Get facts by category.
   */
  getByCategory(category: FactCategory, conversationId?: string): Fact[] {
    let sql = 'SELECT * FROM facts WHERE category = ? AND superseded = 0';
    const params: unknown[] = [category];

    if (conversationId) {
      sql += ' AND conversation_id = ?';
      params.push(conversationId);
    }

    sql += ' ORDER BY created_at DESC';
    const rows = this.db.prepare(sql).all(...params) as FactRow[];
    return rows.map(rowToFact);
  }

  /**
   * Count facts for a conversation.
   */
  countByConversation(conversationId: string, activeOnly = true): number {
    let sql = 'SELECT COUNT(*) as cnt FROM facts WHERE conversation_id = ?';
    if (activeOnly) sql += ' AND superseded = 0';
    const row = this.db.prepare(sql).get(conversationId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Get recent active facts across all conversations, ordered by most recent first.
   * Used by the chat pipeline for recency-based recall (no embedding needed).
   */
  getRecent(limit = 50): Fact[] {
    const rows = this.db.prepare(`
      SELECT * FROM facts WHERE superseded = 0
      ORDER BY created_at DESC LIMIT ?
    `).all(limit) as FactRow[];
    return rows.map(rowToFact);
  }

  /**
   * Delete a fact by ID (for testing/cleanup only).
   */
  delete(factId: string): boolean {
    const result = this.db.prepare('DELETE FROM facts WHERE id = ?').run(factId);
    return result.changes > 0;
  }
}
