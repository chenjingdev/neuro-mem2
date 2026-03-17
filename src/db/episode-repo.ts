/**
 * Repository for Episode node storage.
 * Episodes are extracted in batch and stored as structured records.
 */

import type Database from 'better-sqlite3';
import type { Episode } from '../models/episode.js';

export class EpisodeRepository {
  constructor(private db: Database.Database) {}

  /**
   * Save a batch of episodes for a conversation (transactional).
   */
  saveEpisodes(episodes: Episode[]): void {
    if (episodes.length === 0) return;

    const insert = this.db.prepare(`
      INSERT INTO episodes (id, conversation_id, type, title, description,
        start_turn_index, end_turn_index, source_message_ids, actors,
        outcome, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      for (const ep of episodes) {
        insert.run(
          ep.id,
          ep.conversationId,
          ep.type,
          ep.title,
          ep.description,
          ep.startTurnIndex,
          ep.endTurnIndex,
          JSON.stringify(ep.sourceMessageIds),
          JSON.stringify(ep.actors),
          ep.outcome ?? null,
          ep.createdAt,
          ep.metadata ? JSON.stringify(ep.metadata) : null
        );
      }
    });

    txn();
  }

  /**
   * Get all episodes for a conversation, ordered by start turn index.
   */
  getEpisodesByConversation(conversationId: string): Episode[] {
    const rows = this.db.prepare(`
      SELECT id, conversation_id, type, title, description,
        start_turn_index, end_turn_index, source_message_ids, actors,
        outcome, created_at, metadata
      FROM episodes WHERE conversation_id = ?
      ORDER BY start_turn_index ASC
    `).all(conversationId) as EpisodeRow[];

    return rows.map(r => this.rowToEpisode(r));
  }

  /**
   * Get a single episode by ID.
   */
  getEpisode(episodeId: string): Episode | null {
    const row = this.db.prepare(`
      SELECT id, conversation_id, type, title, description,
        start_turn_index, end_turn_index, source_message_ids, actors,
        outcome, created_at, metadata
      FROM episodes WHERE id = ?
    `).get(episodeId) as EpisodeRow | undefined;

    if (!row) return null;
    return this.rowToEpisode(row);
  }

  /**
   * Get episodes by type across all conversations.
   */
  getEpisodesByType(type: string): Episode[] {
    const rows = this.db.prepare(`
      SELECT id, conversation_id, type, title, description,
        start_turn_index, end_turn_index, source_message_ids, actors,
        outcome, created_at, metadata
      FROM episodes WHERE type = ?
      ORDER BY created_at DESC
    `).all(type) as EpisodeRow[];

    return rows.map(r => this.rowToEpisode(r));
  }

  /**
   * Count episodes for a conversation.
   */
  countEpisodes(conversationId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM episodes WHERE conversation_id = ?'
    ).get(conversationId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Delete all episodes for a conversation (for re-extraction).
   */
  deleteEpisodesByConversation(conversationId: string): number {
    const result = this.db.prepare(
      'DELETE FROM episodes WHERE conversation_id = ?'
    ).run(conversationId);
    return result.changes;
  }

  private rowToEpisode(r: EpisodeRow): Episode {
    return {
      id: r.id,
      conversationId: r.conversation_id,
      type: r.type as Episode['type'],
      title: r.title,
      description: r.description,
      startTurnIndex: r.start_turn_index,
      endTurnIndex: r.end_turn_index,
      sourceMessageIds: JSON.parse(r.source_message_ids),
      actors: JSON.parse(r.actors),
      outcome: r.outcome ?? undefined,
      createdAt: r.created_at,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    };
  }
}

interface EpisodeRow {
  id: string;
  conversation_id: string;
  type: string;
  title: string;
  description: string;
  start_turn_index: number;
  end_turn_index: number;
  source_message_ids: string;
  actors: string;
  outcome: string | null;
  created_at: string;
  metadata: string | null;
}
