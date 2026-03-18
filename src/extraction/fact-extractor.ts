/**
 * Fact Extractor — orchestrates LLM-based fact extraction from conversation turns.
 *
 * This is the main entry point for real-time (per-turn) fact extraction.
 * It coordinates prompt building, LLM calls, response parsing, and ID assignment.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Fact, FactExtractionInput, ExtractedFact } from '../models/fact.js';
import type { LLMProvider } from './llm-provider.js';
import { buildFactExtractionRequest } from './fact-prompt.js';
import { parseFactResponse } from './fact-parser.js';

export interface FactExtractionResult {
  /** Successfully extracted facts */
  facts: Fact[];
  /** Whether extraction succeeded */
  ok: boolean;
  /** Error message if extraction failed */
  error?: string;
  /** Raw LLM response for debugging */
  rawResponse?: string;
}

export class FactExtractor {
  constructor(private llmProvider: LLMProvider) {}

  /**
   * Extract facts from a single conversation turn.
   *
   * This is designed to be called per-turn in real-time as messages arrive.
   */
  async extractFromTurn(input: FactExtractionInput): Promise<FactExtractionResult> {
    // Validate input
    if (!input.userMessage.content.trim() || !input.assistantMessage.content.trim()) {
      return { facts: [], ok: true };
    }

    try {
      // Build the LLM request
      const request = buildFactExtractionRequest(input);

      // Call the LLM
      const response = await this.llmProvider.complete(request);

      // Parse the response
      const parseResult = parseFactResponse(response.content);

      if (parseResult.ok === false) {
        return {
          facts: [],
          ok: false,
          error: parseResult.error,
          rawResponse: response.content,
        };
      }

      // Assign IDs and metadata to create full Fact objects
      const now = new Date().toISOString();
      const sourceTurnIndex = Math.min(input.userMessage.turnIndex, input.assistantMessage.turnIndex);
      const facts: Fact[] = parseResult.facts.map((extracted: ExtractedFact) => ({
        id: uuidv4(),
        conversationId: input.conversationId,
        sourceMessageIds: [`${input.conversationId}:${input.userMessage.turnIndex}`, `${input.conversationId}:${input.assistantMessage.turnIndex}`],
        sourceTurnIndex,
        content: extracted.content,
        category: extracted.category,
        confidence: extracted.confidence,
        entities: extracted.entities,
        subject: extracted.subject,
        predicate: extracted.predicate,
        object: extracted.object,
        superseded: false,
        createdAt: now,
        updatedAt: now,
        metadata: {
          extractionModel: this.llmProvider.name,
        },
      }));

      // Always include rawResponse for debugging visibility
      return { facts, ok: true, rawResponse: response.content };
    } catch (err) {
      return {
        facts: [],
        ok: false,
        error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Extract facts from multiple turns in sequence.
   * Useful for batch processing of existing conversations.
   */
  async extractFromTurns(inputs: FactExtractionInput[]): Promise<FactExtractionResult[]> {
    const results: FactExtractionResult[] = [];
    for (const input of inputs) {
      results.push(await this.extractFromTurn(input));
    }
    return results;
  }
}
