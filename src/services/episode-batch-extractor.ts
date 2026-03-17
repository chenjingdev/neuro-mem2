/**
 * EpisodeBatchExtractor — adapter that bridges EpisodeExtractor
 * with the BatchPipeline's BatchExtractor interface.
 *
 * Responsibilities:
 * 1. Fetch the full conversation from ConversationRepository
 * 2. Run EpisodeExtractor to produce Episode nodes
 * 3. Persist episodes via EpisodeRepository
 * 4. Return summary result for the batch job
 *
 * This is the "glue" that makes episode extraction work as a
 * post-conversation batch job triggered by session.ended events.
 */

import type { BatchExtractor } from './batch-pipeline.js';
import type { ConversationRepository } from '../db/conversation-repo.js';
import type { EpisodeRepository } from '../db/episode-repo.js';
import type { EpisodeExtractor } from '../extraction/episode-extractor.js';
import type { BatchJobType } from '../models/session.js';

export class EpisodeBatchExtractor implements BatchExtractor {
  readonly name = 'episode-batch-extractor';
  readonly jobType: BatchJobType = 'episode_extraction';

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly episodeRepo: EpisodeRepository,
    private readonly episodeExtractor: EpisodeExtractor,
  ) {}

  /**
   * Execute episode extraction for a conversation.
   *
   * @param conversationId - The conversation to extract episodes from
   * @param _sessionId - The session ID (unused but required by interface)
   * @returns Summary result to store with the batch job
   */
  async extract(
    conversationId: string,
    _sessionId: string,
  ): Promise<Record<string, unknown>> {
    // 1. Fetch full conversation
    const conversation = this.conversationRepo.getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    if (conversation.messages.length === 0) {
      return {
        episodeCount: 0,
        extractionTimeMs: 0,
        skipped: true,
        reason: 'empty conversation',
      };
    }

    // 2. Delete any existing episodes for re-extraction idempotency
    const deletedCount = this.episodeRepo.deleteEpisodesByConversation(conversationId);

    // 3. Run the LLM-based extractor
    const result = await this.episodeExtractor.extract(conversation);

    if (!result.ok) {
      throw new Error(result.error || 'Episode extraction failed');
    }

    // 4. Persist extracted episodes
    if (result.episodes.length > 0) {
      this.episodeRepo.saveEpisodes(result.episodes);
    }

    // 5. Return summary
    return {
      episodeCount: result.episodes.length,
      extractionTimeMs: result.extractionTimeMs,
      previousEpisodesDeleted: deletedCount,
      episodeTypes: this.countByType(result.episodes),
    };
  }

  private countByType(
    episodes: Array<{ type: string }>,
  ): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const ep of episodes) {
      counts[ep.type] = (counts[ep.type] || 0) + 1;
    }
    return counts;
  }
}
