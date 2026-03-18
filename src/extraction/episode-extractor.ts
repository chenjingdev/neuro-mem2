/**
 * Episode Extractor — orchestrates LLM-based episode extraction
 * from complete conversations (batch, post-conversation).
 *
 * Episodes represent chronological units of activity (actions, decisions,
 * events, discoveries) identified within a conversation's message flow.
 *
 * This extractor is designed to run as a batch job after a session ends.
 * It processes the full conversation and produces Episode instances
 * with proper source message references.
 */

import { v4 as uuidv4 } from 'uuid';
import type { LLMProvider } from './llm-provider.js';
import type {
  Episode,
  EpisodeExtractionResult,
} from '../models/episode.js';
import type { RawConversation } from '../models/conversation.js';
import { buildEpisodeExtractionRequest } from './episode-prompt.js';
import { parseEpisodeResponse } from './episode-parser.js';

/** Options for episode extraction */
export interface EpisodeExtractorOptions {
  /** Maximum number of episodes to extract per conversation (default: 20) */
  maxEpisodes?: number;
}

const DEFAULT_OPTIONS: Required<EpisodeExtractorOptions> = {
  maxEpisodes: 20,
};

/**
 * Extracts Episode nodes from conversations using an LLM provider.
 *
 * Usage:
 * ```ts
 * const extractor = new EpisodeExtractor(llmProvider);
 * const result = await extractor.extract(conversation);
 * // result.episodes is an array of Episode
 * ```
 */
export class EpisodeExtractor {
  constructor(
    private readonly llmProvider: LLMProvider,
    private readonly options: EpisodeExtractorOptions = {},
  ) {}

  /**
   * Extract episodes from a full conversation.
   *
   * @param conversation - The complete conversation with all messages
   * @returns Extraction result with Episode instances
   */
  async extract(conversation: RawConversation): Promise<EpisodeExtractionResult> {
    const start = Date.now();
    const conversationId = conversation.id;

    // Handle empty conversations
    if (!conversation.messages || conversation.messages.length === 0) {
      return {
        conversationId,
        episodes: [],
        extractionTimeMs: Date.now() - start,
        ok: true,
      };
    }

    try {
      const opts = { ...DEFAULT_OPTIONS, ...this.options };
      const maxEpisodes = opts.maxEpisodes;

      // Build and send LLM request
      const request = buildEpisodeExtractionRequest(
        conversation.messages,
        maxEpisodes,
      );
      const response = await this.llmProvider.complete(request);

      // Parse the LLM response
      const maxTurnIndex = Math.max(
        ...conversation.messages.map((m) => m.turnIndex)
      );
      const parseResult = parseEpisodeResponse(response.content, maxTurnIndex);

      if (!parseResult.ok) {
        return {
          conversationId,
          episodes: [],
          extractionTimeMs: Date.now() - start,
          ok: false,
          error: parseResult.error,
          rawResponse: response.content,
        };
      }

      // Build set of existing turn indices for this conversation
      const existingTurns = new Set<number>();
      for (const msg of conversation.messages) {
        // Track which turn indices exist for this conversation
        existingTurns.add(msg.turnIndex);
      }

      // Convert to Episode instances
      const now = new Date().toISOString();
      const episodes: Episode[] = parseResult.episodes
        .slice(0, maxEpisodes)
        .map((raw) => {
          // Collect source turn refs for the turn range (conversationId:turnIndex format)
          const sourceMessageIds: string[] = [];
          for (let t = raw.startTurnIndex; t <= raw.endTurnIndex; t++) {
            if (existingTurns.has(t)) sourceMessageIds.push(`${conversationId}:${t}`);
          }

          return {
            id: uuidv4(),
            conversationId,
            type: raw.type,
            title: raw.title,
            description: raw.description,
            startTurnIndex: raw.startTurnIndex,
            endTurnIndex: raw.endTurnIndex,
            sourceMessageIds,
            actors: raw.actors,
            outcome: raw.outcome,
            createdAt: now,
            metadata: {
              extractionModel: this.llmProvider.name,
              ...(response.usage ? { tokenUsage: response.usage } : {}),
            },
          };
        });

      return {
        conversationId,
        episodes,
        extractionTimeMs: Date.now() - start,
        ok: true,
      };
    } catch (err) {
      return {
        conversationId,
        episodes: [],
        extractionTimeMs: Date.now() - start,
        ok: false,
        error: `Episode extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
