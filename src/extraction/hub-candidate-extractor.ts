/**
 * HubCandidateExtractor — extracts entity/keyword candidates from ExtractedMemoryNode[]
 * and resolves them against existing hubs via FTS5+cosine hybrid matching.
 *
 * Pipeline position:
 *   MemoryNodeExtractor (LLM) → ExtractedMemoryNode[]
 *     → **HubCandidateExtractor** → HubCandidate[]
 *       → Hub creation / edge linking
 *
 * For each unique entity extracted by the LLM:
 *   1. Normalize + deduplicate (case-insensitive, 한영 혼용 aware)
 *   2. Match against existing hubs via HubMatcher (FTS5 pre-filter → cosine rerank)
 *   3. Classify as 'existing' (matched hub) or 'new' (proposed hub creation)
 *   4. Auto-detect hubType: entity/topic/temporal/composite
 *
 * Design:
 * - No additional LLM calls (budget: 1 call/turn already spent by MemoryNodeExtractor)
 * - Uses HubMatcher for scalable hybrid search (수십만 노드 safe)
 * - Returns all candidates in a single pass for downstream batch processing
 */

import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../retrieval/embedding-provider.js';
import type { ExtractedMemoryNode, MemoryNodeMetadata } from '../models/memory-node.js';
import { HubMatcher, type HubMatch, type HubMatcherConfig } from '../services/hub-matcher.js';

// ─── Configuration ────────────────────────────────────────────────

export interface HubCandidateExtractorConfig {
  /**
   * Cosine similarity threshold for matching an entity to an existing hub.
   * Default: 0.85 (same as HubMatcher default)
   */
  similarityThreshold: number;

  /**
   * Maximum existing hub matches per entity.
   * Default: 3
   */
  maxMatchesPerEntity: number;

  /**
   * Minimum entity string length to be considered a valid candidate.
   * Short strings are likely noise (articles, pronouns, etc.)
   * Default: 2
   */
  minEntityLength: number;

  /**
   * Maximum number of hub candidates to return total.
   * Default: 20
   */
  maxCandidatesTotal: number;

  /**
   * Whether to include keyword-derived candidates (from searchKeywords)
   * in addition to relatedEntities. Keywords that look like named entities
   * (capitalized, multi-word) are included.
   * Default: true
   */
  includeKeywordEntities: boolean;

  /**
   * HubMatcher config override.
   */
  hubMatcherConfig?: Partial<HubMatcherConfig>;
}

export const DEFAULT_HUB_CANDIDATE_CONFIG: HubCandidateExtractorConfig = {
  similarityThreshold: 0.85,
  maxMatchesPerEntity: 3,
  minEntityLength: 2,
  maxCandidatesTotal: 20,
  includeKeywordEntities: true,
};

// ─── Result Types ─────────────────────────────────────────────────

/**
 * A hub candidate — either an existing hub match or a new hub proposal.
 */
export interface HubCandidate {
  /** Normalized entity label */
  label: string;

  /** Whether this matches an existing hub or is a new creation proposal */
  kind: 'existing' | 'new';

  /** Auto-detected hub type */
  hubType: NonNullable<MemoryNodeMetadata['hubType']>;

  /** Existing hub match details (only when kind='existing') */
  existingMatch?: HubMatch;

  /** Source node indices (which extracted nodes mentioned this entity) */
  sourceNodeIndices: number[];

  /** Combined mention frequency across all source nodes */
  mentionCount: number;

  /** Confidence score [0, 1] — for existing: cosine similarity; for new: heuristic */
  confidence: number;
}

/**
 * Result of hub candidate extraction.
 */
export interface HubCandidateExtractionResult {
  /** All hub candidates (existing matches + new proposals), sorted by confidence desc */
  candidates: HubCandidate[];

  /** Candidates that matched existing hubs */
  existingHubs: HubCandidate[];

  /** Candidates proposed as new hubs */
  newHubProposals: HubCandidate[];

  /** Performance and diagnostic stats */
  stats: HubCandidateStats;
}

export interface HubCandidateStats {
  /** Total unique entities extracted from all nodes */
  uniqueEntitiesFound: number;
  /** Entities that matched existing hubs */
  existingHubMatches: number;
  /** Entities proposed as new hubs */
  newHubProposals: number;
  /** Entities filtered out (too short, duplicates, etc.) */
  entitiesFiltered: number;
  /** Total hub matching time (ms) */
  matchingTimeMs: number;
}

// ─── Entity Source Tracking ────────────────────────────────────────

interface EntityOccurrence {
  /** Normalized entity label (lowercase trimmed) */
  normalizedLabel: string;
  /** Original entity labels (preserving case for display) */
  originalLabels: string[];
  /** Source: which extracted node indices produced this entity */
  sourceNodeIndices: Set<number>;
  /** How many times this entity was mentioned across all nodes */
  mentionCount: number;
  /** Was this from relatedEntities (high signal) or keywords (lower signal)? */
  fromRelatedEntities: boolean;
}

// ─── HubCandidateExtractor ────────────────────────────────────────

export class HubCandidateExtractor {
  private hubMatcher: HubMatcher;
  private config: HubCandidateExtractorConfig;

  constructor(
    db: Database.Database,
    config?: Partial<HubCandidateExtractorConfig>,
  ) {
    this.config = { ...DEFAULT_HUB_CANDIDATE_CONFIG, ...config };
    this.hubMatcher = new HubMatcher(db, {
      similarityThreshold: this.config.similarityThreshold,
      maxMatches: this.config.maxMatchesPerEntity,
      ...this.config.hubMatcherConfig,
    });
  }

  /**
   * Extract hub candidates from a set of extracted memory nodes.
   *
   * @param nodes - ExtractedMemoryNode[] from MemoryNodeExtractor
   * @param embeddingProvider - Provider to generate embeddings for hub matching
   * @returns HubCandidateExtractionResult with existing + new candidates
   */
  async extract(
    nodes: ExtractedMemoryNode[],
    embeddingProvider: EmbeddingProvider,
  ): Promise<HubCandidateExtractionResult> {
    const startTime = performance.now();

    // Step 1: Collect and deduplicate entities across all nodes
    const entityMap = this.collectEntities(nodes);
    const uniqueEntities = Array.from(entityMap.values());
    let entitiesFiltered = 0;

    // Step 2: Filter out too-short entities
    const validEntities = uniqueEntities.filter((e) => {
      if (e.normalizedLabel.length < this.config.minEntityLength) {
        entitiesFiltered++;
        return false;
      }
      return true;
    });

    // Step 3: Match each entity against existing hubs
    const candidates: HubCandidate[] = [];
    const seenHubIds = new Set<string>();

    for (const entity of validEntities) {
      // Pick best original label (prefer the most common casing)
      const displayLabel = this.pickDisplayLabel(entity);

      // Build search text from entity label
      const searchText = displayLabel;

      try {
        // Use HubMatcher with async embedding generation
        const matchResult = await this.hubMatcher.matchWithEmbedding(
          searchText,
          embeddingProvider,
          { maxMatches: this.config.maxMatchesPerEntity },
        );

        if (matchResult.matches.length > 0) {
          // Entity matched existing hub(s) — pick the best match
          const bestMatch = matchResult.matches[0]!;

          // Avoid duplicate hub references
          if (!seenHubIds.has(bestMatch.hubId)) {
            seenHubIds.add(bestMatch.hubId);
            candidates.push({
              label: displayLabel,
              kind: 'existing',
              hubType: detectHubType(displayLabel, entity.fromRelatedEntities),
              existingMatch: bestMatch,
              sourceNodeIndices: Array.from(entity.sourceNodeIndices),
              mentionCount: entity.mentionCount,
              confidence: bestMatch.cosineSimilarity,
            });
          }
        } else {
          // No existing hub match → propose new hub
          candidates.push({
            label: displayLabel,
            kind: 'new',
            hubType: detectHubType(displayLabel, entity.fromRelatedEntities),
            sourceNodeIndices: Array.from(entity.sourceNodeIndices),
            mentionCount: entity.mentionCount,
            confidence: computeNewHubConfidence(entity),
          });
        }
      } catch {
        // If embedding fails for this entity, still propose as new hub with lower confidence
        candidates.push({
          label: displayLabel,
          kind: 'new',
          hubType: detectHubType(displayLabel, entity.fromRelatedEntities),
          sourceNodeIndices: Array.from(entity.sourceNodeIndices),
          mentionCount: entity.mentionCount,
          confidence: 0.3, // low confidence due to matching failure
        });
      }
    }

    // Step 4: Sort by confidence desc, limit total
    candidates.sort((a, b) => b.confidence - a.confidence);
    const limitedCandidates = candidates.slice(0, this.config.maxCandidatesTotal);

    const existingHubs = limitedCandidates.filter((c) => c.kind === 'existing');
    const newHubProposals = limitedCandidates.filter((c) => c.kind === 'new');

    const matchingTimeMs = Math.round((performance.now() - startTime) * 100) / 100;

    return {
      candidates: limitedCandidates,
      existingHubs,
      newHubProposals,
      stats: {
        uniqueEntitiesFound: uniqueEntities.length,
        existingHubMatches: existingHubs.length,
        newHubProposals: newHubProposals.length,
        entitiesFiltered,
        matchingTimeMs,
      },
    };
  }

  /**
   * Synchronous variant — when embeddings are already available.
   * Matches entities against existing hubs using pre-computed embeddings.
   *
   * @param nodes - ExtractedMemoryNode[] from MemoryNodeExtractor
   * @param nodeEmbeddings - Map of entity label → embedding (pre-computed)
   */
  extractSync(
    nodes: ExtractedMemoryNode[],
    nodeEmbeddings: Map<string, number[] | Float32Array>,
  ): HubCandidateExtractionResult {
    const startTime = performance.now();

    const entityMap = this.collectEntities(nodes);
    const uniqueEntities = Array.from(entityMap.values());
    let entitiesFiltered = 0;

    const validEntities = uniqueEntities.filter((e) => {
      if (e.normalizedLabel.length < this.config.minEntityLength) {
        entitiesFiltered++;
        return false;
      }
      return true;
    });

    const candidates: HubCandidate[] = [];
    const seenHubIds = new Set<string>();

    for (const entity of validEntities) {
      const displayLabel = this.pickDisplayLabel(entity);
      const embedding = nodeEmbeddings.get(entity.normalizedLabel)
        ?? nodeEmbeddings.get(displayLabel);

      if (embedding) {
        const matchResult = this.hubMatcher.match(
          displayLabel,
          embedding,
          { maxMatches: this.config.maxMatchesPerEntity },
        );

        if (matchResult.matches.length > 0) {
          const bestMatch = matchResult.matches[0]!;
          if (!seenHubIds.has(bestMatch.hubId)) {
            seenHubIds.add(bestMatch.hubId);
            candidates.push({
              label: displayLabel,
              kind: 'existing',
              hubType: detectHubType(displayLabel, entity.fromRelatedEntities),
              existingMatch: bestMatch,
              sourceNodeIndices: Array.from(entity.sourceNodeIndices),
              mentionCount: entity.mentionCount,
              confidence: bestMatch.cosineSimilarity,
            });
          }
        } else {
          candidates.push({
            label: displayLabel,
            kind: 'new',
            hubType: detectHubType(displayLabel, entity.fromRelatedEntities),
            sourceNodeIndices: Array.from(entity.sourceNodeIndices),
            mentionCount: entity.mentionCount,
            confidence: computeNewHubConfidence(entity),
          });
        }
      } else {
        // No embedding available — propose as new hub
        candidates.push({
          label: displayLabel,
          kind: 'new',
          hubType: detectHubType(displayLabel, entity.fromRelatedEntities),
          sourceNodeIndices: Array.from(entity.sourceNodeIndices),
          mentionCount: entity.mentionCount,
          confidence: computeNewHubConfidence(entity) * 0.8,
        });
      }
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    const limitedCandidates = candidates.slice(0, this.config.maxCandidatesTotal);

    const existingHubs = limitedCandidates.filter((c) => c.kind === 'existing');
    const newHubProposals = limitedCandidates.filter((c) => c.kind === 'new');

    const matchingTimeMs = Math.round((performance.now() - startTime) * 100) / 100;

    return {
      candidates: limitedCandidates,
      existingHubs,
      newHubProposals,
      stats: {
        uniqueEntitiesFound: uniqueEntities.length,
        existingHubMatches: existingHubs.length,
        newHubProposals: newHubProposals.length,
        entitiesFiltered,
        matchingTimeMs,
      },
    };
  }

  // ─── Internal: Entity Collection ────────────────────────────────

  /**
   * Collect and deduplicate entities from all extracted nodes.
   * Sources: relatedEntities (primary) + searchKeywords (if enabled) + metadata.entities
   */
  private collectEntities(nodes: ExtractedMemoryNode[]): Map<string, EntityOccurrence> {
    const entityMap = new Map<string, EntityOccurrence>();

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;

      // Primary source: relatedEntities (high signal)
      for (const entity of node.relatedEntities) {
        this.addEntity(entityMap, entity, i, true);
      }

      // Secondary source: metadata.entities
      if (node.metadata.entities) {
        for (const entity of node.metadata.entities) {
          this.addEntity(entityMap, entity, i, true);
        }
      }

      // Tertiary source: searchKeywords that look like named entities
      if (this.config.includeKeywordEntities) {
        for (const keyword of node.searchKeywords) {
          if (looksLikeNamedEntity(keyword)) {
            this.addEntity(entityMap, keyword, i, false);
          }
        }
      }
    }

    return entityMap;
  }

  private addEntity(
    entityMap: Map<string, EntityOccurrence>,
    rawLabel: string,
    nodeIndex: number,
    fromRelatedEntities: boolean,
  ): void {
    const normalized = normalizeEntityLabel(rawLabel);
    if (!normalized) return;

    const existing = entityMap.get(normalized);
    if (existing) {
      existing.sourceNodeIndices.add(nodeIndex);
      existing.mentionCount++;
      if (!existing.originalLabels.includes(rawLabel)) {
        existing.originalLabels.push(rawLabel);
      }
      if (fromRelatedEntities) {
        existing.fromRelatedEntities = true;
      }
    } else {
      entityMap.set(normalized, {
        normalizedLabel: normalized,
        originalLabels: [rawLabel],
        sourceNodeIndices: new Set([nodeIndex]),
        mentionCount: 1,
        fromRelatedEntities,
      });
    }
  }

  /**
   * Pick the best display label from original labels.
   * Prefers: most common casing > first occurrence > normalized label.
   */
  private pickDisplayLabel(entity: EntityOccurrence): string {
    if (entity.originalLabels.length === 0) return entity.normalizedLabel;
    if (entity.originalLabels.length === 1) return entity.originalLabels[0]!;

    // Count occurrences of each casing
    const caseCounts = new Map<string, number>();
    for (const label of entity.originalLabels) {
      caseCounts.set(label, (caseCounts.get(label) ?? 0) + 1);
    }

    // Pick the one with highest count
    let best = entity.originalLabels[0]!;
    let bestCount = 0;
    caseCounts.forEach((count, label) => {
      if (count > bestCount) {
        bestCount = count;
        best = label;
      }
    });
    return best;
  }
}

// ─── Pure Helper Functions (exported for testing) ─────────────────

/**
 * Normalize an entity label for deduplication.
 * - Trims whitespace
 * - Lowercases (for Latin characters; Korean is case-insensitive)
 * - Collapses internal whitespace
 * - Returns empty string for invalid inputs
 */
export function normalizeEntityLabel(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Heuristic: does this keyword look like a named entity?
 *
 * Named entities tend to be:
 * - Capitalized (English): "React", "TypeScript"
 * - Multi-word: "machine learning"
 * - Korean proper nouns (2+ syllables, no common suffixes)
 * - Technical terms with special chars: "Node.js", "C++"
 */
export function looksLikeNamedEntity(keyword: string): boolean {
  const trimmed = keyword.trim();
  if (trimmed.length < 2) return false;

  // Korean text: multi-syllable words are likely named entities
  // (단일 글자 조사/접속사 제외)
  if (/[\uAC00-\uD7AF]/.test(trimmed)) {
    // Korean text: accept if 2+ Korean chars
    const koreanChars = trimmed.match(/[\uAC00-\uD7AF]/g);
    return (koreanChars?.length ?? 0) >= 2;
  }

  // English: starts with uppercase → likely a named entity
  if (/^[A-Z]/.test(trimmed)) return true;

  // Technical terms with dots, plus, hash: "Node.js", "C++", "C#"
  if (/[.+#]/.test(trimmed)) return true;

  // Multi-word phrases (likely concepts/topics)
  if (trimmed.includes(' ') && trimmed.split(' ').length >= 2) return true;

  return false;
}

/**
 * Auto-detect hub type based on entity label heuristics.
 *
 * - 'entity': Named things (people, orgs, tools, places)
 * - 'topic': Abstract themes, domains, concepts
 * - 'temporal': Time-bound events, periods
 * - 'composite': Multi-theme or ambiguous
 */
export function detectHubType(
  label: string,
  fromRelatedEntities: boolean,
): NonNullable<MemoryNodeMetadata['hubType']> {
  const lower = label.toLowerCase();

  // Temporal signals
  if (
    /\b(20\d{2}|q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(label) ||
    /(월|년|분기|기간)/.test(label)
  ) {
    return 'temporal';
  }

  // Named entity signals (from relatedEntities + capitalized proper noun)
  if (fromRelatedEntities && /^[A-Z][a-z]/.test(label)) {
    return 'entity';
  }

  // Technical/tool names: "React", "TypeScript", "PostgreSQL"
  if (/^[A-Z][a-zA-Z0-9.+#]*$/.test(label.split(' ')[0] ?? '')) {
    return 'entity';
  }

  // Korean named entities (specific name patterns)
  if (/^[\uAC00-\uD7AF]{2,4}$/.test(label)) {
    // Short Korean words (2-4 syllables) could be names
    return fromRelatedEntities ? 'entity' : 'topic';
  }

  // Multi-word abstract phrases (all lowercase) are usually topics, not named entities
  if (lower.includes(' ') && label === lower) {
    return 'topic';
  }

  // Default: entity if from relatedEntities, topic otherwise
  return fromRelatedEntities ? 'entity' : 'topic';
}

/**
 * Compute a heuristic confidence score for a new hub proposal.
 *
 * Higher confidence for:
 * - Entities from relatedEntities (LLM explicitly identified them)
 * - Higher mention count (multiple nodes reference the entity)
 * - Entities mentioned in multiple different nodes
 */
export function computeNewHubConfidence(entity: EntityOccurrence): number {
  let score = 0.5; // base

  // Boost for being from relatedEntities (LLM explicitly extracted)
  if (entity.fromRelatedEntities) {
    score += 0.2;
  }

  // Boost for multi-node mentions (entity spans multiple extracted nodes)
  const uniqueNodes = entity.sourceNodeIndices.size;
  if (uniqueNodes >= 3) score += 0.15;
  else if (uniqueNodes >= 2) score += 0.1;

  // Boost for high mention count
  if (entity.mentionCount >= 3) score += 0.1;

  return Math.min(1.0, score);
}
