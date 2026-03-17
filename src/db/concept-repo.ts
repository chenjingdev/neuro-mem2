/**
 * Repository for Concept node storage.
 * Concepts are extracted in batch and deduplicated by canonical name.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Concept, CreateConceptInput, UpdateConceptInput } from '../models/concept.js';

export class ConceptRepository {
  constructor(private db: Database.Database) {}

  /**
   * Save a new concept. Returns the persisted Concept.
   */
  createConcept(input: CreateConceptInput): Concept {
    const now = new Date().toISOString();
    const id = uuidv4();

    const concept: Concept = {
      id,
      name: input.name,
      description: input.description,
      aliases: input.aliases ?? [],
      category: input.category,
      relevance: input.relevance ?? 0.5,
      sourceConversationIds: [input.sourceConversationId],
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };

    this.db.prepare(`
      INSERT INTO concepts (id, name, description, aliases, category, relevance,
        source_conversation_ids, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      concept.id,
      concept.name,
      concept.description,
      JSON.stringify(concept.aliases),
      concept.category,
      concept.relevance,
      JSON.stringify(concept.sourceConversationIds),
      concept.createdAt,
      concept.updatedAt,
      concept.metadata ? JSON.stringify(concept.metadata) : null
    );

    return concept;
  }

  /**
   * Save a batch of concepts for a conversation (transactional).
   */
  saveConcepts(inputs: CreateConceptInput[]): Concept[] {
    if (inputs.length === 0) return [];

    const concepts: Concept[] = [];
    const now = new Date().toISOString();

    const insert = this.db.prepare(`
      INSERT INTO concepts (id, name, description, aliases, category, relevance,
        source_conversation_ids, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      for (const input of inputs) {
        const id = uuidv4();
        const concept: Concept = {
          id,
          name: input.name,
          description: input.description,
          aliases: input.aliases ?? [],
          category: input.category,
          relevance: input.relevance ?? 0.5,
          sourceConversationIds: [input.sourceConversationId],
          createdAt: now,
          updatedAt: now,
          metadata: input.metadata,
        };

        insert.run(
          concept.id,
          concept.name,
          concept.description,
          JSON.stringify(concept.aliases),
          concept.category,
          concept.relevance,
          JSON.stringify(concept.sourceConversationIds),
          concept.createdAt,
          concept.updatedAt,
          concept.metadata ? JSON.stringify(concept.metadata) : null
        );

        concepts.push(concept);
      }
    });

    txn();
    return concepts;
  }

  /**
   * Get a concept by ID.
   */
  getConcept(conceptId: string): Concept | null {
    const row = this.db.prepare(`
      SELECT id, name, description, aliases, category, relevance,
        source_conversation_ids, created_at, updated_at, metadata
      FROM concepts WHERE id = ?
    `).get(conceptId) as ConceptRow | undefined;

    if (!row) return null;
    return this.rowToConcept(row);
  }

  /**
   * Find a concept by canonical name (case-insensitive).
   */
  findByName(name: string): Concept | null {
    const row = this.db.prepare(`
      SELECT id, name, description, aliases, category, relevance,
        source_conversation_ids, created_at, updated_at, metadata
      FROM concepts WHERE LOWER(name) = LOWER(?)
    `).get(name) as ConceptRow | undefined;

    if (!row) return null;
    return this.rowToConcept(row);
  }

  /**
   * Get all concepts for a given category.
   */
  getConceptsByCategory(category: string): Concept[] {
    const rows = this.db.prepare(`
      SELECT id, name, description, aliases, category, relevance,
        source_conversation_ids, created_at, updated_at, metadata
      FROM concepts WHERE category = ?
      ORDER BY relevance DESC
    `).all(category) as ConceptRow[];

    return rows.map(r => this.rowToConcept(r));
  }

  /**
   * Get all concepts, optionally ordered by relevance.
   */
  listConcepts(options: { limit?: number; offset?: number } = {}): Concept[] {
    const { limit = 100, offset = 0 } = options;
    const rows = this.db.prepare(`
      SELECT id, name, description, aliases, category, relevance,
        source_conversation_ids, created_at, updated_at, metadata
      FROM concepts
      ORDER BY relevance DESC, name ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as ConceptRow[];

    return rows.map(r => this.rowToConcept(r));
  }

  /**
   * Update an existing concept (e.g., add a source conversation, merge aliases).
   */
  updateConcept(conceptId: string, input: UpdateConceptInput): Concept | null {
    const existing = this.getConcept(conceptId);
    if (!existing) return null;

    const now = new Date().toISOString();
    let aliases = existing.aliases;
    let sourceIds = existing.sourceConversationIds;
    let relevance = existing.relevance;
    let description = existing.description;
    let metadata = existing.metadata;

    if (input.addAliases) {
      const aliasSet = new Set([...aliases, ...input.addAliases]);
      aliases = [...aliasSet];
    }

    if (input.addSourceConversationId && !sourceIds.includes(input.addSourceConversationId)) {
      sourceIds = [...sourceIds, input.addSourceConversationId];
    }

    if (input.relevance !== undefined) {
      relevance = input.relevance;
    }

    if (input.description !== undefined) {
      description = input.description;
    }

    if (input.metadata) {
      metadata = { ...metadata, ...input.metadata };
    }

    this.db.prepare(`
      UPDATE concepts SET
        aliases = ?, relevance = ?, description = ?,
        source_conversation_ids = ?, updated_at = ?, metadata = ?
      WHERE id = ?
    `).run(
      JSON.stringify(aliases),
      relevance,
      description,
      JSON.stringify(sourceIds),
      now,
      metadata ? JSON.stringify(metadata) : null,
      conceptId
    );

    return {
      ...existing,
      aliases,
      sourceConversationIds: sourceIds,
      relevance,
      description,
      updatedAt: now,
      metadata,
    };
  }

  /**
   * Count all concepts.
   */
  countConcepts(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM concepts').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Delete all concepts from a specific source conversation.
   * (For re-extraction scenarios)
   */
  deleteConceptsByConversation(conversationId: string): number {
    // Find concepts where this is the only source conversation
    const rows = this.db.prepare(`
      SELECT id, source_conversation_ids FROM concepts
    `).all() as Array<{ id: string; source_conversation_ids: string }>;

    let deleted = 0;
    const txn = this.db.transaction(() => {
      for (const row of rows) {
        const sourceIds: string[] = JSON.parse(row.source_conversation_ids);
        if (sourceIds.includes(conversationId)) {
          if (sourceIds.length === 1) {
            // This was the only source — delete the concept
            this.db.prepare('DELETE FROM concepts WHERE id = ?').run(row.id);
            deleted++;
          } else {
            // Remove just this conversation from sources
            const newSourceIds = sourceIds.filter(id => id !== conversationId);
            this.db.prepare(`
              UPDATE concepts SET source_conversation_ids = ?, updated_at = ? WHERE id = ?
            `).run(JSON.stringify(newSourceIds), new Date().toISOString(), row.id);
          }
        }
      }
    });

    txn();
    return deleted;
  }

  private rowToConcept(r: ConceptRow): Concept {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      aliases: JSON.parse(r.aliases),
      category: r.category as Concept['category'],
      relevance: r.relevance,
      sourceConversationIds: JSON.parse(r.source_conversation_ids),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    };
  }
}

interface ConceptRow {
  id: string;
  name: string;
  description: string;
  aliases: string;
  category: string;
  relevance: number;
  source_conversation_ids: string;
  created_at: string;
  updated_at: string;
  metadata: string | null;
}
