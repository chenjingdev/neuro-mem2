/**
 * Unified MemoryNode Extractor — single LLM call per turn extracts all nodeTypes
 * with searchKeywords and relatedEntities.
 *
 * Replaces the separate FactExtractor, EpisodeExtractor, and ConceptExtractor
 * with a single unified extraction that respects the 1-call/turn budget.
 *
 * Key outputs per node:
 * - searchKeywords → L0 keywords (FTS5-indexed, 한영 혼용)
 * - relatedEntities → L1 metadata.entities + hub matching candidates
 */

import { v4 as uuidv4 } from 'uuid';
import type { LLMProvider } from './llm-provider.js';
import type { MemoryNodeExtractionInput } from './memory-node-prompt.js';
import { buildMemoryNodeExtractionRequest } from './memory-node-prompt.js';
import { parseMemoryNodeResponse } from './memory-node-parser.js';
import type {
  ExtractedMemoryNode,
  CreateMemoryNodeInput,
} from '../models/memory-node.js';

// ─── Result Types ────────────────────────────────────────────────

export interface MemoryNodeExtractionResult {
  /** Successfully extracted nodes */
  nodes: ExtractedMemoryNode[];
  /** CreateMemoryNodeInput objects ready for repository insertion */
  createInputs: CreateMemoryNodeInput[];
  /** Whether extraction succeeded */
  ok: boolean;
  /** Error message if extraction failed */
  error?: string;
  /** Raw LLM response for debugging */
  rawResponse?: string;
}

// ─── Extractor ───────────────────────────────────────────────────

export class MemoryNodeExtractor {
  constructor(private llmProvider: LLMProvider) {}

  /**
   * Extract memory nodes from a single conversation turn.
   *
   * Single LLM call extracts ALL nodeTypes with searchKeywords + relatedEntities.
   * This is the 1-call/turn budget-compliant extraction.
   */
  async extractFromTurn(
    input: MemoryNodeExtractionInput,
    currentEventCounter?: number,
  ): Promise<MemoryNodeExtractionResult> {
    // Validate input
    if (!input.userMessage.content.trim() || !input.assistantMessage.content.trim()) {
      return { nodes: [], createInputs: [], ok: true };
    }

    try {
      // Build the LLM request — single call for all nodeTypes
      const request = buildMemoryNodeExtractionRequest(input);

      // Call the LLM (1 call per turn)
      const response = await this.llmProvider.complete(request);

      // Parse the response
      const parseResult = parseMemoryNodeResponse(response.content);

      if (parseResult.ok === false) {
        return {
          nodes: [],
          createInputs: [],
          ok: false,
          error: parseResult.error,
          rawResponse: response.content,
        };
      }

      // Build source references
      const sourceTurnIndex = Math.min(
        input.userMessage.turnIndex,
        input.assistantMessage.turnIndex,
      );
      const sourceMessageIds = [
        `${input.conversationId}:${input.userMessage.turnIndex}`,
        `${input.conversationId}:${input.assistantMessage.turnIndex}`,
      ];

      // Convert extracted nodes to CreateMemoryNodeInput
      const createInputs: CreateMemoryNodeInput[] = parseResult.nodes.map((node) => ({
        nodeType: node.nodeType,
        nodeRole: node.nodeRole ?? 'leaf',
        frontmatter: node.frontmatter,
        keywords: node.keywords, // from searchKeywords → space-separated
        summary: node.summary,
        metadata: {
          ...node.metadata,
          // Ensure entities are preserved from relatedEntities
          entities: node.relatedEntities.length > 0
            ? Array.from(new Set([...(node.metadata.entities ?? []), ...node.relatedEntities]))
            : node.metadata.entities,
          extractionModel: this.llmProvider.name,
        },
        sourceMessageIds,
        conversationId: input.conversationId,
        sourceTurnIndex,
        currentEventCounter,
      }));

      return {
        nodes: parseResult.nodes,
        createInputs,
        ok: true,
        rawResponse: response.content,
      };
    } catch (err) {
      return {
        nodes: [],
        createInputs: [],
        ok: false,
        error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Extract from multiple turns in sequence (batch processing).
   */
  async extractFromTurns(
    inputs: MemoryNodeExtractionInput[],
    currentEventCounter?: number,
  ): Promise<MemoryNodeExtractionResult[]> {
    const results: MemoryNodeExtractionResult[] = [];
    for (const input of inputs) {
      results.push(await this.extractFromTurn(input, currentEventCounter));
    }
    return results;
  }
}
