/**
 * ConceptBatchExtractor — adapter that bridges ConceptExtractor
 * with the BatchPipeline's BatchExtractor interface.
 *
 * Responsibilities:
 * 1. Fetch the full conversation from ConversationRepository
 * 2. Load existing facts from FactRepository (for grounding)
 * 3. Load existing concepts from ConceptRepository (for deduplication)
 * 4. Run ConceptExtractor to produce Concept nodes + edges
 * 5. Persist new concepts via ConceptRepository (with dedup/merge)
 * 6. Persist relationship edges via EdgeRepository
 * 7. Return summary result for the batch job
 *
 * This is the "glue" that makes concept extraction work as a
 * post-conversation batch job triggered by session.ended events.
 */

import type { BatchExtractor } from './batch-pipeline.js';
import type { ConversationRepository } from '../db/conversation-repo.js';
import type { FactRepository } from '../db/fact-repo.js';
import type { ConceptRepository } from '../db/concept-repo.js';
import type { EdgeRepository } from '../db/edge-repo.js';
import type { ConceptExtractor } from '../extraction/concept-extractor.js';
import type { ConceptExtractionInput } from '../extraction/concept-prompt.js';
import type { BatchJobType } from '../models/session.js';

/** Result summary stored with the batch job */
export interface ConceptBatchResult {
  /** Number of new concepts created */
  newConceptCount: number;
  /** Number of existing concepts updated (new source conversation added) */
  updatedConceptCount: number;
  /** Number of concept_related_to edges created */
  edgeCount: number;
  /** Number of fact_supports_concept edges created */
  factConceptEdgeCount: number;
  /** Milliseconds spent on extraction */
  extractionTimeMs: number;
  /** Whether the conversation was skipped (empty) */
  skipped?: boolean;
  /** Reason for skipping */
  reason?: string;
  /** Previously existing concepts deleted for re-extraction */
  previousConceptsDeleted?: number;
  /** Category breakdown of extracted concepts */
  conceptCategories?: Record<string, number>;
}

export class ConceptBatchExtractor implements BatchExtractor {
  readonly name = 'concept-batch-extractor';
  readonly jobType: BatchJobType = 'concept_extraction';

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly factRepo: FactRepository,
    private readonly conceptRepo: ConceptRepository,
    private readonly edgeRepo: EdgeRepository,
    private readonly conceptExtractor: ConceptExtractor,
  ) {}

  /**
   * Execute concept extraction for a conversation.
   *
   * @param conversationId - The conversation to extract concepts from
   * @param _sessionId - The session ID (unused but required by interface)
   * @returns Summary result to store with the batch job
   */
  async extract(
    conversationId: string,
    _sessionId: string,
  ): Promise<Record<string, unknown>> {
    const start = Date.now();

    // 1. Fetch full conversation
    const conversation = this.conversationRepo.getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    if (conversation.messages.length === 0) {
      return {
        newConceptCount: 0,
        updatedConceptCount: 0,
        edgeCount: 0,
        factConceptEdgeCount: 0,
        extractionTimeMs: Date.now() - start,
        skipped: true,
        reason: 'empty conversation',
      } satisfies ConceptBatchResult;
    }

    // 2. Load existing facts for grounding
    const existingFacts = this.factRepo.getActiveByConversation(conversationId);
    const factContext = existingFacts.map((f) => ({
      content: f.content,
      category: f.category,
      entities: f.entities,
    }));

    // 3. Load existing concepts for deduplication
    const allConcepts = this.conceptRepo.listConcepts({ limit: 1000 });
    const existingConceptContext = allConcepts.map((c) => ({
      name: c.name,
      aliases: c.aliases,
      category: c.category,
    }));

    // 4. Build extraction input
    const extractionInput: ConceptExtractionInput = {
      conversationId,
      messages: conversation.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      existingFacts: factContext.length > 0 ? factContext : undefined,
      existingConcepts: existingConceptContext.length > 0 ? existingConceptContext : undefined,
    };

    // 5. Run LLM-based concept extraction
    const result = await this.conceptExtractor.extract(extractionInput);

    // 6. Persist concepts — check for existing concepts to update vs. create new
    let newConceptCount = 0;
    let updatedConceptCount = 0;
    const conceptIdMap = new Map<string, string>(); // extractedNode.id -> persisted concept id

    for (const node of result.concepts) {
      // Check if concept already exists by name (case-insensitive)
      const existing = this.conceptRepo.findByName(node.name);

      if (existing) {
        // Update existing concept: add source conversation, merge aliases
        this.conceptRepo.updateConcept(existing.id, {
          addSourceConversationId: conversationId,
          addAliases: node.aliases,
          relevance: Math.max(
            existing.relevance,
            (node.metadata as Record<string, unknown>)?.relevance as number ?? 0.5,
          ),
        });
        conceptIdMap.set(node.id, existing.id);
        updatedConceptCount++;
      } else {
        // Create new concept
        const created = this.conceptRepo.createConcept({
          name: node.name,
          description: node.content,
          aliases: node.aliases,
          category: node.category,
          relevance: (node.metadata as Record<string, unknown>)?.relevance as number ?? 0.5,
          sourceConversationId: conversationId,
          metadata: node.metadata,
        });
        conceptIdMap.set(node.id, created.id);
        newConceptCount++;
      }
    }

    // 7. Persist concept_related_to edges (remapping IDs)
    let edgeCount = 0;
    for (const edge of result.edges) {
      const sourceId = conceptIdMap.get(edge.sourceId) ?? edge.sourceId;
      const targetId = conceptIdMap.get(edge.targetId) ?? edge.targetId;

      try {
        this.edgeRepo.upsertEdge({
          sourceId,
          sourceType: 'concept',
          targetId,
          targetType: 'concept',
          edgeType: 'concept_related_to',
          weight: edge.weight ?? 0.5,
          metadata: { conversationId },
        });
        edgeCount++;
      } catch {
        // Edge might fail if concept ID doesn't exist — skip
      }
    }

    // 8. Build fact_supports_concept edges
    let factConceptEdgeCount = 0;
    if (existingFacts.length > 0 && result.concepts.length > 0) {
      factConceptEdgeCount = this.buildFactConceptEdges(
        existingFacts,
        result.concepts,
        conceptIdMap,
        conversationId,
      );
    }

    const extractionTimeMs = Date.now() - start;

    return {
      newConceptCount,
      updatedConceptCount,
      edgeCount,
      factConceptEdgeCount,
      extractionTimeMs,
      conceptCategories: this.countByCategory(result.concepts),
    } satisfies ConceptBatchResult;
  }

  /**
   * Build fact_supports_concept edges by matching fact entities to concept names/aliases.
   * Returns the number of edges created.
   */
  private buildFactConceptEdges(
    facts: Array<{ id: string; entities: string[] }>,
    concepts: Array<{
      id: string;
      name: string;
      aliases?: string[];
      metadata: Record<string, unknown>;
    }>,
    conceptIdMap: Map<string, string>,
    conversationId: string,
  ): number {
    // Build a lookup: lowercase name/alias -> persisted concept ID
    const nameToConceptId = new Map<string, string>();
    for (const c of concepts) {
      const persistedId = conceptIdMap.get(c.id);
      if (!persistedId) continue;

      nameToConceptId.set(c.name.toLowerCase(), persistedId);
      for (const alias of c.aliases ?? []) {
        nameToConceptId.set(alias.toLowerCase(), persistedId);
      }
    }

    let count = 0;
    const seen = new Set<string>(); // "factId:conceptId" dedup

    for (const fact of facts) {
      for (const entity of fact.entities) {
        const conceptId = nameToConceptId.get(entity.toLowerCase());
        if (!conceptId) continue;

        const key = `${fact.id}:${conceptId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        try {
          this.edgeRepo.upsertEdge({
            sourceId: fact.id,
            sourceType: 'fact',
            targetId: conceptId,
            targetType: 'concept',
            edgeType: 'fact_supports_concept',
            weight: 0.6,
            metadata: { conversationId },
          });
          count++;
        } catch {
          // Skip on error
        }
      }
    }

    return count;
  }

  private countByCategory(
    concepts: Array<{ category: string }>,
  ): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const c of concepts) {
      counts[c.category] = (counts[c.category] || 0) + 1;
    }
    return counts;
  }
}
