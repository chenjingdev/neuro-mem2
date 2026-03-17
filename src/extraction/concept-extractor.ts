/**
 * Concept Extractor — orchestrates LLM-based concept extraction
 * from complete conversations (batch, post-conversation).
 *
 * Concepts represent recurring themes, technologies, domain terms,
 * and preferences identified across conversation messages.
 *
 * This extractor is designed to run as a batch job after a session ends.
 * It processes the full conversation, leveraging previously extracted facts
 * for grounding, and produces ConceptNode instances with relationship edges.
 */

import { v4 as uuidv4 } from 'uuid';
import type { LLMProvider } from './llm-provider.js';
import {
  buildConceptExtractionRequest,
  type ConceptExtractionInput,
  type ExtractedConcept,
  type ConceptCategory,
  CONCEPT_CATEGORIES,
} from './concept-prompt.js';
import type { CreateEdgeInput } from '../models/memory-edge.js';

/** Internal graph node representation for extracted concepts */
interface ConceptNode {
  id: string;
  type: 'concept';
  name: string;
  content: string;
  aliases?: string[];
  category: ConceptCategory;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

/** Result of concept extraction for a conversation */
export interface ConceptExtractionResult {
  /** The conversation ID that was processed */
  conversationId: string;
  /** Extracted concept nodes */
  concepts: ConceptNode[];
  /** Suggested edges between concepts (concept_related_to) */
  edges: CreateEdgeInput[];
  /** Suggested edges linking facts to concepts (fact_supports_concept) */
  factConceptEdges: CreateEdgeInput[];
  /** ISO 8601 timestamp of extraction */
  extractedAt: string;
}

/** Options for concept extraction */
export interface ConceptExtractorOptions {
  /** Minimum relevance score to include a concept (default: 0.4) */
  minRelevance?: number;
  /** Maximum number of concepts to extract (default: 20) */
  maxConcepts?: number;
}

const DEFAULT_OPTIONS: Required<ConceptExtractorOptions> = {
  minRelevance: 0.4,
  maxConcepts: 20,
};

/**
 * Extracts Concept nodes from conversations using an LLM provider.
 */
export class ConceptExtractor {
  constructor(
    private readonly llmProvider: LLMProvider,
    private readonly options: ConceptExtractorOptions = {},
  ) {}

  /**
   * Extract concepts from a full conversation.
   *
   * @param input - The conversation data and optional context
   * @returns Extracted concepts with relationship edges
   */
  async extract(input: ConceptExtractionInput): Promise<ConceptExtractionResult> {
    const opts = { ...DEFAULT_OPTIONS, ...this.options };
    const now = new Date().toISOString();

    // Validate input
    if (!input.messages || input.messages.length === 0) {
      return {
        conversationId: input.conversationId,
        concepts: [],
        edges: [],
        factConceptEdges: [],
        extractedAt: now,
      };
    }

    // Build and send LLM request
    const request = buildConceptExtractionRequest(input);
    const response = await this.llmProvider.complete(request);

    // Parse LLM response
    const rawConcepts = this.parseResponse(response.content);

    // Filter by relevance and limit count
    const filteredConcepts = rawConcepts
      .filter((c) => c.relevance >= opts.minRelevance)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, opts.maxConcepts);

    // Deduplicate against existing concepts
    const deduped = this.deduplicateConcepts(filteredConcepts, input.existingConcepts);

    // Convert to ConceptNode instances
    const conceptNodes = deduped.map((raw) => this.toConceptNode(raw, now));

    // Build a name->id lookup for edge creation
    const nameToId = new Map<string, string>();
    for (const node of conceptNodes) {
      nameToId.set(node.name.toLowerCase(), node.id);
      for (const alias of node.aliases ?? []) {
        nameToId.set(alias.toLowerCase(), node.id);
      }
    }
    // Include existing concept names in lookup
    if (input.existingConcepts) {
      for (const ec of input.existingConcepts) {
        // Existing concepts don't have IDs here, skip for edge creation
        // They are for deduplication only
      }
    }

    // Create concept_related_to edges
    const edges = this.buildConceptEdges(deduped, nameToId, now);

    return {
      conversationId: input.conversationId,
      concepts: conceptNodes,
      edges,
      factConceptEdges: [], // Populated by the batch pipeline with actual fact IDs
      extractedAt: now,
    };
  }

  /**
   * Parse the LLM JSON response into ExtractedConcept objects.
   */
  private parseResponse(content: string): ExtractedConcept[] {
    try {
      // Try to extract JSON from response (handle markdown code blocks)
      let jsonStr = content.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      const parsed = JSON.parse(jsonStr);

      if (!parsed || !Array.isArray(parsed.concepts)) {
        return [];
      }

      return parsed.concepts
        .filter((c: any) => this.isValidRawConcept(c))
        .map((c: any) => this.normalizeRawConcept(c));
    } catch {
      // If JSON parsing fails, return empty — don't throw
      return [];
    }
  }

  /**
   * Validate a raw concept object from LLM output.
   */
  private isValidRawConcept(c: any): boolean {
    return (
      typeof c === 'object' &&
      c !== null &&
      typeof c.name === 'string' &&
      c.name.trim().length > 0 &&
      typeof c.description === 'string' &&
      typeof c.relevance === 'number' &&
      !isNaN(c.relevance)
    );
  }

  /**
   * Normalize a raw concept from LLM output into a typed ExtractedConcept.
   */
  private normalizeRawConcept(c: any): ExtractedConcept {
    const category = CONCEPT_CATEGORIES.includes(c.category)
      ? (c.category as ConceptCategory)
      : 'other';

    return {
      name: c.name.trim(),
      description: typeof c.description === 'string' ? c.description.trim() : '',
      aliases: Array.isArray(c.aliases)
        ? c.aliases.filter((a: any) => typeof a === 'string' && a.trim().length > 0).map((a: string) => a.trim())
        : [],
      category,
      relevance: Math.max(0, Math.min(1, c.relevance)),
      relatedConcepts: Array.isArray(c.relatedConcepts)
        ? c.relatedConcepts.filter((r: any) => typeof r === 'string' && r.trim().length > 0).map((r: string) => r.trim())
        : [],
    };
  }

  /**
   * Deduplicate extracted concepts against existing concepts.
   * If an extracted concept matches an existing one (by name or alias),
   * it is excluded from the results.
   */
  private deduplicateConcepts(
    extracted: ExtractedConcept[],
    existing?: Array<{ name: string; aliases: string[]; category: string }>,
  ): ExtractedConcept[] {
    if (!existing || existing.length === 0) {
      return this.deduplicateAmongThemselves(extracted);
    }

    // Build a set of all known names/aliases (lowercase)
    const knownNames = new Set<string>();
    for (const ec of existing) {
      knownNames.add(ec.name.toLowerCase());
      for (const alias of ec.aliases) {
        knownNames.add(alias.toLowerCase());
      }
    }

    // Filter out concepts that already exist
    const novel = extracted.filter((c) => {
      const nameLC = c.name.toLowerCase();
      if (knownNames.has(nameLC)) return false;
      // Check if any alias matches
      return !c.aliases.some((a) => knownNames.has(a.toLowerCase()));
    });

    return this.deduplicateAmongThemselves(novel);
  }

  /**
   * Deduplicate concepts within the extracted batch.
   * If two concepts share a name or alias, keep the one with higher relevance.
   */
  private deduplicateAmongThemselves(concepts: ExtractedConcept[]): ExtractedConcept[] {
    const seen = new Map<string, number>(); // lowercase name -> index in result
    const result: ExtractedConcept[] = [];

    for (const concept of concepts) {
      const nameLC = concept.name.toLowerCase();
      const allNames = [nameLC, ...concept.aliases.map((a) => a.toLowerCase())];

      let existingIdx: number | undefined;
      for (const n of allNames) {
        if (seen.has(n)) {
          existingIdx = seen.get(n);
          break;
        }
      }

      if (existingIdx !== undefined) {
        // Merge: keep higher relevance, merge aliases
        const existing = result[existingIdx];
        if (concept.relevance > existing.relevance) {
          // Replace but keep merged aliases
          const mergedAliases = new Set([
            ...existing.aliases.map((a) => a.toLowerCase()),
            ...concept.aliases.map((a) => a.toLowerCase()),
            existing.name.toLowerCase(),
          ]);
          mergedAliases.delete(concept.name.toLowerCase());

          const merged: ExtractedConcept = {
            ...concept,
            aliases: [...mergedAliases].map((a) => {
              // Try to preserve original casing
              const origAlias = [...existing.aliases, ...concept.aliases, existing.name]
                .find((orig) => orig.toLowerCase() === a);
              return origAlias ?? a;
            }),
            relatedConcepts: [...new Set([...existing.relatedConcepts, ...concept.relatedConcepts])],
          };
          result[existingIdx] = merged;
        } else {
          // Keep existing but merge aliases from new
          const mergedAliases = new Set([
            ...existing.aliases.map((a) => a.toLowerCase()),
            ...concept.aliases.map((a) => a.toLowerCase()),
            concept.name.toLowerCase(),
          ]);
          mergedAliases.delete(existing.name.toLowerCase());

          existing.aliases = [...mergedAliases].map((a) => {
            const origAlias = [...existing.aliases, ...concept.aliases, concept.name]
              .find((orig) => orig.toLowerCase() === a);
            return origAlias ?? a;
          });
          existing.relatedConcepts = [...new Set([...existing.relatedConcepts, ...concept.relatedConcepts])];
        }
      } else {
        // New concept
        const idx = result.length;
        result.push(concept);
        for (const n of allNames) {
          seen.set(n, idx);
        }
      }
    }

    return result;
  }

  /**
   * Convert an ExtractedConcept to a ConceptNode.
   */
  private toConceptNode(raw: ExtractedConcept, timestamp: string): ConceptNode {
    return {
      id: uuidv4(),
      type: 'concept',
      name: raw.name,
      content: raw.description,
      aliases: raw.aliases.length > 0 ? raw.aliases : undefined,
      category: raw.category,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        relevance: raw.relevance,
        relatedConcepts: raw.relatedConcepts,
      },
    };
  }

  /**
   * Build concept_related_to edges between extracted concepts.
   */
  private buildConceptEdges(
    concepts: ExtractedConcept[],
    nameToId: Map<string, string>,
    timestamp: string,
  ): CreateEdgeInput[] {
    const edges: CreateEdgeInput[] = [];
    const edgeSet = new Set<string>(); // "sourceId:targetId" to avoid duplicates

    for (const concept of concepts) {
      const sourceId = nameToId.get(concept.name.toLowerCase());
      if (!sourceId) continue;

      for (const relatedName of concept.relatedConcepts) {
        const targetId = nameToId.get(relatedName.toLowerCase());
        if (!targetId || targetId === sourceId) continue;

        // Avoid duplicate edges (A->B and B->A)
        const edgeKey = [sourceId, targetId].sort().join(':');
        if (edgeSet.has(edgeKey)) continue;
        edgeSet.add(edgeKey);

        // Weight based on average relevance of the two concepts
        const targetConcept = concepts.find(
          (c) => c.name.toLowerCase() === relatedName.toLowerCase(),
        );
        const weight = targetConcept
          ? (concept.relevance + targetConcept.relevance) / 2
          : concept.relevance * 0.5;

        edges.push({
          sourceId,
          sourceType: 'concept',
          targetId,
          targetType: 'concept',
          edgeType: 'concept_related_to',
          weight: Math.round(weight * 100) / 100,
        });
      }
    }

    return edges;
  }
}
