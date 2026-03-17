/**
 * AnchorLinker — parses LLM anchor-linking decisions and executes
 * anchor connections / creations for ingested facts.
 *
 * This is the "brain-like" component: given a fact and candidate anchors
 * (from AnchorCandidateFinder), the LLM decides which existing anchors
 * the fact should connect to and whether new anchors should be created.
 * This service then executes those decisions against the DB.
 *
 * Pipeline position:
 *   AnchorCandidateFinder → LLM prompt → **AnchorLinker** → DB (anchors + weighted_edges)
 *
 * Design decisions:
 * - LLM returns structured JSON with explicit connect/create instructions
 * - Robust parsing with graceful degradation (warnings, not errors)
 * - Reuses existing AnchorRepository.createAnchor + WeightedEdgeRepository.createEdge
 * - Embeds new anchors immediately so they participate in future candidate searches
 * - Fully local: LLMProvider + EmbeddingProvider, no external API
 */

import type { LLMProvider } from '../extraction/llm-provider.js';
import type { EmbeddingProvider } from '../retrieval/embedding-provider.js';
import type { AnchorRepository } from '../db/anchor-repo.js';
import type { WeightedEdgeRepository } from '../db/weighted-edge-repo.js';
import type { AnchorCandidate } from './anchor-candidate-finder.js';
import type { AnchorType } from '../models/anchor.js';
import type { Fact } from '../models/fact.js';

// ─── LLM Response Schema ─────────────────────────────────────────

/**
 * A single "connect to existing anchor" instruction from the LLM.
 */
export interface LLMAnchorConnect {
  /** Anchor ID to connect the fact to */
  anchorId: string;
  /** Relevance weight for the edge [0, 1] */
  weight: number;
  /** Brief reason for the connection (for traceability) */
  reason?: string;
}

/**
 * A single "create new anchor" instruction from the LLM.
 */
export interface LLMAnchorCreate {
  /** Label for the new anchor */
  label: string;
  /** Description of the anchor's semantic scope */
  description: string;
  /** Anchor type */
  anchorType: AnchorType;
  /** Optional aliases */
  aliases?: string[];
  /** Initial edge weight for connecting the fact [0, 1] */
  weight?: number;
  /** Brief reason for creation (for traceability) */
  reason?: string;
}

/**
 * The full LLM anchor-linking decision for a single fact.
 */
export interface LLMAnchorDecision {
  /** Existing anchors to connect the fact to */
  connect: LLMAnchorConnect[];
  /** New anchors to create and connect the fact to */
  create: LLMAnchorCreate[];
}

// ─── Execution Result ────────────────────────────────────────────

/**
 * Result of executing an anchor-linking decision.
 */
export interface AnchorLinkResult {
  /** Fact ID that was linked */
  factId: string;
  /** Edges created to existing anchors */
  connectedEdges: Array<{
    edgeId: string;
    anchorId: string;
    anchorLabel: string;
    weight: number;
  }>;
  /** Newly created anchors (with edges) */
  createdAnchors: Array<{
    anchorId: string;
    label: string;
    edgeId: string;
    weight: number;
  }>;
  /** Warnings during execution (non-fatal) */
  warnings: string[];
  /** Performance stats */
  stats: {
    llmTimeMs: number;
    executionTimeMs: number;
    connectAttempts: number;
    connectSuccesses: number;
    createAttempts: number;
    createSuccesses: number;
  };
}

// ─── Configuration ───────────────────────────────────────────────

export interface AnchorLinkerConfig {
  /**
   * LLM temperature for anchor-linking decisions.
   * Default: 0.2 (very deterministic — structural decisions)
   */
  temperature: number;

  /**
   * Max tokens for LLM response.
   * Default: 500
   */
  maxTokens: number;

  /**
   * Default initial weight for new anchor-to-fact edges.
   * Default: 0.5
   */
  defaultEdgeWeight: number;

  /**
   * Default initial weight for newly created anchors.
   * Default: 0.5
   */
  defaultAnchorWeight: number;

  /**
   * Whether to embed newly created anchors immediately.
   * Default: true (so they can be found by future candidate searches)
   */
  embedNewAnchors: boolean;
}

export const DEFAULT_ANCHOR_LINKER_CONFIG: AnchorLinkerConfig = {
  temperature: 0.2,
  maxTokens: 500,
  defaultEdgeWeight: 0.5,
  defaultAnchorWeight: 0.5,
  embedNewAnchors: true,
};

// ─── Prompt Builder ──────────────────────────────────────────────

/**
 * Build the LLM prompt for anchor-linking decisions.
 */
export function buildAnchorLinkPrompt(
  factContent: string,
  candidates: AnchorCandidate[],
): { system: string; prompt: string } {
  const system = [
    'You are the associative memory linker for a brain-like memory system.',
    'Given a fact and a list of existing anchor nodes (semantic hubs),',
    'decide which anchors this fact should connect to and whether new anchors should be created.',
    '',
    'Rules:',
    '- Connect the fact to existing anchors that are semantically relevant.',
    '- Create new anchors only when the fact introduces a genuinely new topic/entity/theme',
    '  not covered by existing anchors.',
    '- Each connection needs a weight (0.0-1.0) indicating relevance strength.',
    '- You may connect to multiple anchors and/or create multiple new ones.',
    '- If no anchors are relevant and no new ones needed, return empty arrays.',
    '',
    'Respond with ONLY valid JSON in this exact format:',
    '{',
    '  "connect": [',
    '    { "anchorId": "<id>", "weight": 0.8, "reason": "brief reason" }',
    '  ],',
    '  "create": [',
    '    { "label": "New Topic", "description": "what this anchor covers",',
    '      "anchorType": "topic|entity|temporal", "weight": 0.7, "reason": "brief reason" }',
    '  ]',
    '}',
  ].join('\n');

  const candidateList = candidates.length > 0
    ? candidates
        .map(
          (c) =>
            `  - [${c.anchorId}] "${c.label}" (${c.anchorType}): ${c.description} (similarity: ${c.similarity})`,
        )
        .join('\n')
    : '  (none)';

  const prompt = [
    `Fact: "${factContent}"`,
    '',
    `Existing anchor candidates:`,
    candidateList,
    '',
    'Decide which anchors to connect and/or create.',
  ].join('\n');

  return { system, prompt };
}

// ─── Response Parser ─────────────────────────────────────────────

const VALID_ANCHOR_TYPES = new Set<string>(['entity', 'topic', 'temporal', 'composite']);

/**
 * Parse and validate the LLM's anchor-linking decision.
 * Returns a validated decision with warnings for invalid entries.
 */
export function parseAnchorDecision(
  raw: string,
  validAnchorIds: Set<string>,
): { decision: LLMAnchorDecision; warnings: string[] } {
  const warnings: string[] = [];
  const decision: LLMAnchorDecision = { connect: [], create: [] };

  // Extract JSON from response (handle markdown code blocks)
  let jsonStr = raw.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    warnings.push(`Failed to parse LLM response as JSON: ${raw.slice(0, 200)}`);
    return { decision, warnings };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    warnings.push('LLM response is not a JSON object');
    return { decision, warnings };
  }

  const obj = parsed as Record<string, unknown>;

  // Parse "connect" array
  if (Array.isArray(obj.connect)) {
    for (const item of obj.connect) {
      if (typeof item !== 'object' || item === null) {
        warnings.push(`Invalid connect entry: ${JSON.stringify(item)}`);
        continue;
      }
      const c = item as Record<string, unknown>;

      // Validate anchorId
      if (typeof c.anchorId !== 'string' || !c.anchorId) {
        warnings.push(`Connect entry missing anchorId: ${JSON.stringify(item)}`);
        continue;
      }
      if (!validAnchorIds.has(c.anchorId)) {
        warnings.push(`Connect entry references unknown anchor: ${c.anchorId}`);
        continue;
      }

      // Validate weight
      const weight = typeof c.weight === 'number'
        ? Math.max(0, Math.min(1, c.weight))
        : 0.5;

      decision.connect.push({
        anchorId: c.anchorId,
        weight,
        reason: typeof c.reason === 'string' ? c.reason : undefined,
      });
    }
  }

  // Parse "create" array
  if (Array.isArray(obj.create)) {
    for (const item of obj.create) {
      if (typeof item !== 'object' || item === null) {
        warnings.push(`Invalid create entry: ${JSON.stringify(item)}`);
        continue;
      }
      const c = item as Record<string, unknown>;

      // Validate label
      if (typeof c.label !== 'string' || !c.label.trim()) {
        warnings.push(`Create entry missing label: ${JSON.stringify(item)}`);
        continue;
      }

      // Validate description
      if (typeof c.description !== 'string' || !c.description.trim()) {
        warnings.push(`Create entry missing description: ${JSON.stringify(item)}`);
        continue;
      }

      // Validate anchorType
      const anchorType = typeof c.anchorType === 'string' && VALID_ANCHOR_TYPES.has(c.anchorType)
        ? (c.anchorType as AnchorType)
        : 'topic'; // Default to topic

      if (typeof c.anchorType === 'string' && !VALID_ANCHOR_TYPES.has(c.anchorType)) {
        warnings.push(`Invalid anchorType "${c.anchorType}", defaulting to "topic"`);
      }

      // Validate weight
      const weight = typeof c.weight === 'number'
        ? Math.max(0, Math.min(1, c.weight))
        : undefined;

      // Validate aliases
      const aliases = Array.isArray(c.aliases)
        ? (c.aliases as unknown[]).filter((a): a is string => typeof a === 'string')
        : undefined;

      decision.create.push({
        label: c.label.trim(),
        description: c.description.trim(),
        anchorType,
        aliases: aliases && aliases.length > 0 ? aliases : undefined,
        weight,
        reason: typeof c.reason === 'string' ? c.reason : undefined,
      });
    }
  }

  return { decision, warnings };
}

// ─── AnchorLinker Service ────────────────────────────────────────

export class AnchorLinker {
  readonly config: AnchorLinkerConfig;

  constructor(
    private readonly llmProvider: LLMProvider,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly anchorRepo: AnchorRepository,
    private readonly edgeRepo: WeightedEdgeRepository,
    config?: Partial<AnchorLinkerConfig>,
  ) {
    this.config = { ...DEFAULT_ANCHOR_LINKER_CONFIG, ...config };
  }

  /**
   * Given a fact and anchor candidates (from AnchorCandidateFinder),
   * ask the LLM to decide anchor connections/creations, then execute them.
   *
   * @param fact - The persisted fact to link
   * @param candidates - Anchor candidates from AnchorCandidateFinder
   * @param factEmbedding - Pre-computed fact embedding (for new anchor embedding)
   * @returns Execution result with created edges/anchors and stats
   */
  async linkFact(
    fact: Fact,
    candidates: AnchorCandidate[],
    factEmbedding?: number[],
  ): Promise<AnchorLinkResult> {
    const warnings: string[] = [];
    const connectedEdges: AnchorLinkResult['connectedEdges'] = [];
    const createdAnchors: AnchorLinkResult['createdAnchors'] = [];

    // Step 1: Ask LLM for anchor-linking decision
    const llmStart = performance.now();
    let decision: LLMAnchorDecision;

    try {
      const { system, prompt } = buildAnchorLinkPrompt(fact.content, candidates);
      const response = await this.llmProvider.complete({
        system,
        prompt,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        responseFormat: 'json',
      });

      const validAnchorIds = new Set(candidates.map((c) => c.anchorId));
      const parseResult = parseAnchorDecision(response.content, validAnchorIds);
      decision = parseResult.decision;
      warnings.push(...parseResult.warnings);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      warnings.push(`LLM anchor-linking failed: ${errMsg}`);
      decision = { connect: [], create: [] };
    }
    const llmTimeMs = round2(performance.now() - llmStart);

    // Step 2: Execute the decision
    const execStart = performance.now();
    let connectSuccesses = 0;
    let createSuccesses = 0;

    // 2a: Connect fact to existing anchors
    for (const conn of decision.connect) {
      try {
        const anchor = this.anchorRepo.getAnchor(conn.anchorId);
        if (!anchor) {
          warnings.push(`Anchor ${conn.anchorId} not found during connection`);
          continue;
        }

        const edge = this.edgeRepo.createEdge({
          sourceId: conn.anchorId,
          sourceType: 'anchor',
          targetId: fact.id,
          targetType: 'fact',
          edgeType: 'anchor_to_fact',
          weight: conn.weight,
          metadata: conn.reason ? { reason: conn.reason } : undefined,
        });

        // Record activation on the anchor (Hebbian reinforcement signal)
        this.anchorRepo.recordActivation(conn.anchorId);

        connectedEdges.push({
          edgeId: edge.id,
          anchorId: conn.anchorId,
          anchorLabel: anchor.label,
          weight: conn.weight,
        });
        connectSuccesses++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Failed to connect fact to anchor ${conn.anchorId}: ${errMsg}`);
      }
    }

    // 2b: Create new anchors and connect fact to them
    for (const create of decision.create) {
      try {
        // Check for duplicate label (case-insensitive)
        const existing = this.anchorRepo.findByLabel(create.label);
        if (existing) {
          // Connect to existing instead of creating duplicate
          const edgeWeight = create.weight ?? this.config.defaultEdgeWeight;
          const edge = this.edgeRepo.createEdge({
            sourceId: existing.id,
            sourceType: 'anchor',
            targetId: fact.id,
            targetType: 'fact',
            edgeType: 'anchor_to_fact',
            weight: edgeWeight,
            metadata: create.reason
              ? { reason: create.reason, note: 'connected to existing (duplicate label)' }
              : { note: 'connected to existing (duplicate label)' },
          });

          this.anchorRepo.recordActivation(existing.id);

          connectedEdges.push({
            edgeId: edge.id,
            anchorId: existing.id,
            anchorLabel: existing.label,
            weight: edgeWeight,
          });
          connectSuccesses++;
          warnings.push(
            `Anchor "${create.label}" already exists (${existing.id}), connected instead of creating`,
          );
          continue;
        }

        // Embed the new anchor's description
        let embedding: Float32Array | undefined;
        if (this.config.embedNewAnchors) {
          try {
            const embResponse = await this.embeddingProvider.embed({
              text: `${create.label}: ${create.description}`,
            });
            embedding = new Float32Array(embResponse.embedding);
          } catch (embErr) {
            const errMsg = embErr instanceof Error ? embErr.message : String(embErr);
            warnings.push(`Failed to embed new anchor "${create.label}": ${errMsg}`);
          }
        }

        // Create the anchor
        const anchor = this.anchorRepo.createAnchor({
          label: create.label,
          description: create.description,
          anchorType: create.anchorType,
          aliases: create.aliases,
          embedding,
          initialWeight: this.config.defaultAnchorWeight,
          metadata: create.reason ? { creationReason: create.reason } : undefined,
        });

        // Create edge from anchor to fact
        const edgeWeight = create.weight ?? this.config.defaultEdgeWeight;
        const edge = this.edgeRepo.createEdge({
          sourceId: anchor.id,
          sourceType: 'anchor',
          targetId: fact.id,
          targetType: 'fact',
          edgeType: 'anchor_to_fact',
          weight: edgeWeight,
          metadata: create.reason ? { reason: create.reason } : undefined,
        });

        createdAnchors.push({
          anchorId: anchor.id,
          label: create.label,
          edgeId: edge.id,
          weight: edgeWeight,
        });
        createSuccesses++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Failed to create anchor "${create.label}": ${errMsg}`);
      }
    }

    const executionTimeMs = round2(performance.now() - execStart);

    return {
      factId: fact.id,
      connectedEdges,
      createdAnchors,
      warnings,
      stats: {
        llmTimeMs,
        executionTimeMs,
        connectAttempts: decision.connect.length,
        connectSuccesses,
        createAttempts: decision.create.length,
        createSuccesses,
      },
    };
  }

  /**
   * Link multiple facts in batch.
   * Each fact gets its own LLM call and execution.
   */
  async linkFacts(
    facts: Array<{ fact: Fact; candidates: AnchorCandidate[]; factEmbedding?: number[] }>,
  ): Promise<AnchorLinkResult[]> {
    const results: AnchorLinkResult[] = [];
    for (const { fact, candidates, factEmbedding } of facts) {
      const result = await this.linkFact(fact, candidates, factEmbedding);
      results.push(result);
    }
    return results;
  }
}

// ─── Internal Utilities ──────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
