/**
 * AnchorJudgment — LLM-based service that decides how a fact connects to
 * existing anchors or whether new anchors should be created.
 *
 * This is the "binding judge" in the brain-like memory pipeline:
 *   AnchorCandidateFinder (coarse embedding filter) →
 *   **AnchorJudgment (LLM fine decision)** →
 *   Edge creation / Anchor creation
 *
 * The LLM receives the fact + candidate anchors and returns structured
 * decisions: connect to existing anchor(s) or create new one(s).
 *
 * Design decisions:
 * - Follows the same LLMProvider pattern as FactExtractor, ConceptExtractor
 * - Returns structured, typed decisions for downstream edge/anchor creation
 * - Graceful degradation: if LLM fails, falls back to similarity-based heuristic
 * - Pipeline traceability: tracks timing and decision metadata
 */

import type { LLMProvider } from '../extraction/llm-provider.js';
import {
  buildAnchorJudgmentRequest,
  type AnchorJudgmentInput,
  type AnchorJudgmentResponse,
  type AnchorDecision,
  type AnchorConnectDecision,
  type AnchorCreateDecision,
} from '../extraction/anchor-judgment-prompt.js';
import type { AnchorCandidate } from './anchor-candidate-finder.js';

// ─── Result Types ────────────────────────────────────────────────

/** Full result from the anchor judgment service. */
export interface AnchorJudgmentResult {
  /** Parsed anchor decisions from LLM */
  decisions: AnchorDecision[];
  /** Whether the fact is isolated (no meaningful anchor connections) */
  isolated: boolean;
  /** Whether the result came from LLM or fallback heuristic */
  source: 'llm' | 'heuristic';
  /** Performance and debug stats */
  stats: {
    /** Time for LLM call (ms) */
    llmTimeMs: number;
    /** Number of candidates presented to LLM */
    candidatesPresented: number;
    /** Number of connect decisions */
    connectCount: number;
    /** Number of create decisions */
    createCount: number;
  };
  /** Raw LLM response for debugging */
  rawResponse?: string;
  /** Error message if LLM failed (result is from fallback) */
  error?: string;
}

// ─── Configuration ───────────────────────────────────────────────

export interface AnchorJudgmentConfig {
  /**
   * Minimum similarity score to auto-connect in heuristic fallback.
   * Default: 0.6
   */
  heuristicConnectThreshold: number;

  /**
   * Default connection strength for heuristic fallback connections.
   * Default: 0.5
   */
  heuristicDefaultStrength: number;

  /**
   * Whether to create a new anchor in heuristic mode when no candidates match.
   * Default: true
   */
  heuristicCreateWhenEmpty: boolean;
}

export const DEFAULT_JUDGMENT_CONFIG: AnchorJudgmentConfig = {
  heuristicConnectThreshold: 0.6,
  heuristicDefaultStrength: 0.5,
  heuristicCreateWhenEmpty: true,
};

// ─── AnchorJudgment Service ──────────────────────────────────────

export class AnchorJudgment {
  readonly config: AnchorJudgmentConfig;

  constructor(
    private readonly llmProvider: LLMProvider,
    config?: Partial<AnchorJudgmentConfig>,
  ) {
    this.config = { ...DEFAULT_JUDGMENT_CONFIG, ...config };
  }

  /**
   * Judge how a fact should connect to the memory graph.
   *
   * @param input - Fact content + candidate anchors from coarse filter
   * @returns Structured decisions (connect/create) with traceability stats
   */
  async judge(input: AnchorJudgmentInput): Promise<AnchorJudgmentResult> {
    const start = performance.now();

    try {
      // Build and send LLM request
      const request = buildAnchorJudgmentRequest(input);
      const response = await this.llmProvider.complete(request);
      const llmTimeMs = round2(performance.now() - start);

      // Parse the response
      const parsed = parseAnchorJudgmentResponse(
        response.content,
        input.candidates,
      );

      return {
        decisions: parsed.decisions,
        isolated: parsed.isolated,
        source: 'llm',
        stats: {
          llmTimeMs,
          candidatesPresented: input.candidates.length,
          connectCount: parsed.decisions.filter(d => d.action === 'connect').length,
          createCount: parsed.decisions.filter(d => d.action === 'create').length,
        },
        rawResponse: response.content,
      };
    } catch (err) {
      const llmTimeMs = round2(performance.now() - start);
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Graceful degradation: fall back to similarity-based heuristic
      const fallback = this.heuristicFallback(input);

      return {
        ...fallback,
        source: 'heuristic',
        stats: {
          ...fallback.stats,
          llmTimeMs,
        },
        error: `LLM failed, using heuristic: ${errorMsg}`,
      };
    }
  }

  /**
   * Heuristic fallback when LLM is unavailable.
   * Uses similarity scores from coarse filter to make simple decisions.
   */
  private heuristicFallback(input: AnchorJudgmentInput): AnchorJudgmentResult {
    const decisions: AnchorDecision[] = [];

    // Connect to candidates above threshold
    for (const candidate of input.candidates) {
      if (candidate.similarity >= this.config.heuristicConnectThreshold) {
        decisions.push({
          action: 'connect',
          anchorId: candidate.anchorId,
          strength: Math.min(candidate.similarity, 1.0),
          reason: `Heuristic: similarity ${candidate.similarity.toFixed(3)} above threshold`,
        } satisfies AnchorConnectDecision);
      }
    }

    // If no connections and config allows, suggest creating an anchor
    const isolated =
      decisions.length === 0 && !this.config.heuristicCreateWhenEmpty;

    if (decisions.length === 0 && this.config.heuristicCreateWhenEmpty) {
      // Derive anchor from fact entities or content
      const label = deriveAnchorLabel(input);
      if (label) {
        decisions.push({
          action: 'create',
          label,
          description: `Auto-generated anchor for: ${input.factContent.slice(0, 100)}`,
          anchorType: inferAnchorType(input),
          strength: this.config.heuristicDefaultStrength,
          reason: 'Heuristic: no existing anchors matched, creating new anchor',
        } satisfies AnchorCreateDecision);
      }
    }

    return {
      decisions,
      isolated,
      source: 'heuristic',
      stats: {
        llmTimeMs: 0,
        candidatesPresented: input.candidates.length,
        connectCount: decisions.filter(d => d.action === 'connect').length,
        createCount: decisions.filter(d => d.action === 'create').length,
      },
    };
  }
}

// ─── Response Parser ─────────────────────────────────────────────

/**
 * Parse and validate the LLM's anchor judgment JSON response.
 * Validates anchor IDs against actual candidates to prevent hallucination.
 */
export function parseAnchorJudgmentResponse(
  raw: string,
  candidates: AnchorCandidate[],
): AnchorJudgmentResponse {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse anchor judgment JSON: ${raw.slice(0, 200)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Anchor judgment response is not an object');
  }

  const obj = parsed as Record<string, unknown>;
  const isolated = Boolean(obj.isolated);

  // Build valid anchor ID set for validation
  const validAnchorIds = new Set(candidates.map(c => c.anchorId));

  // Parse decisions array
  const rawDecisions = Array.isArray(obj.decisions) ? obj.decisions : [];
  const decisions: AnchorDecision[] = [];

  for (const d of rawDecisions) {
    if (!d || typeof d !== 'object') continue;
    const dec = d as Record<string, unknown>;

    if (dec.action === 'connect') {
      const anchorId = String(dec.anchorId ?? '');
      // Validate anchor ID exists in candidates (anti-hallucination)
      if (!validAnchorIds.has(anchorId)) continue;

      decisions.push({
        action: 'connect',
        anchorId,
        strength: clampStrength(dec.strength),
        reason: String(dec.reason ?? ''),
      });
    } else if (dec.action === 'create') {
      const label = String(dec.label ?? '').trim();
      if (!label) continue; // Skip empty labels

      decisions.push({
        action: 'create',
        label,
        description: String(dec.description ?? ''),
        anchorType: validateAnchorType(dec.anchorType),
        strength: clampStrength(dec.strength),
        reason: String(dec.reason ?? ''),
      });
    }
    // Skip unknown actions
  }

  return { decisions, isolated };
}

// ─── Internal Helpers ────────────────────────────────────────────

function clampStrength(value: unknown): number {
  const n = Number(value);
  if (isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function validateAnchorType(
  value: unknown,
): 'entity' | 'topic' | 'temporal' | 'composite' {
  const valid = ['entity', 'topic', 'temporal', 'composite'];
  const s = String(value ?? 'topic');
  return valid.includes(s) ? (s as 'entity' | 'topic' | 'temporal' | 'composite') : 'topic';
}

function deriveAnchorLabel(input: AnchorJudgmentInput): string | null {
  // Use entities if available
  if (input.factEntities.length > 0) {
    return input.factEntities.slice(0, 3).join(' + ');
  }
  // Fall back to first few meaningful words from content
  const words = input.factContent
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 4);
  return words.length >= 2 ? words.join(' ') : null;
}

function inferAnchorType(
  input: AnchorJudgmentInput,
): 'entity' | 'topic' | 'temporal' | 'composite' {
  // If fact has named entities, likely an entity anchor
  if (input.factEntities.length > 0) return 'entity';
  // If category is relationship or knowledge, likely topic
  if (['relationship', 'knowledge', 'technical'].includes(input.factCategory)) {
    return 'topic';
  }
  return 'topic';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
