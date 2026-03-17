/**
 * Re-ranking Prompt — generates LLM prompts for re-ranking retrieval results.
 *
 * After the coarse embedding-based retrieval (cosine similarity on anchors),
 * the LLM acts as a "relevance judge" that examines anchor+fact context
 * and re-scores each item against the original query.
 *
 * This is the brain-like "attention" step: the query activates anchors,
 * those anchors spread activation to connected facts, and the LLM
 * performs a focused relevance assessment — like cortical re-evaluation
 * of subcortical pattern matches.
 *
 * Pipeline position:
 *   UnifiedRetriever → embedding search → expansion →
 *   **LLM re-ranking** → Hebbian reinforcement → final results
 */

import type { LLMCompletionRequest } from './llm-provider.js';

// ─── Types ───────────────────────────────────────────────────────

/** A single candidate item to be re-ranked by the LLM. */
export interface RerankCandidate {
  /** Unique item ID (for mapping back to ScoredMemoryItem) */
  id: string;
  /** Node type (fact, episode, concept, anchor) */
  nodeType: string;
  /** Text content of the item */
  content: string;
  /** The anchor label that led to this item (if expanded) */
  anchorLabel?: string;
  /** Original coarse score from embedding search */
  coarseScore: number;
}

/** Input for the re-ranking LLM call. */
export interface RerankInput {
  /** The original query text */
  query: string;
  /** Candidate items to re-rank */
  candidates: RerankCandidate[];
}

/** A single re-ranked item from the LLM response. */
export interface RerankScore {
  /** Item ID (from RerankCandidate) */
  id: string;
  /** LLM-assessed relevance score [0.0-1.0] */
  relevance: number;
  /** Brief reason for the score (optional) */
  reason?: string;
}

/** Expected JSON structure from the LLM re-ranking response. */
export interface RerankResponse {
  /** Re-ranked items with relevance scores */
  scores: RerankScore[];
}

// ─── System Prompt ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a relevance judge for a brain-like memory retrieval system. Your role is to re-rank memory items by their relevance to a user's query.

You will receive:
1. A query (what the user is looking for)
2. A list of candidate memory items (found by embedding similarity search)

Each candidate has an ID, type, content, and optionally the anchor (semantic hub) it was connected through.

Your job: assess how relevant each candidate is to the query and assign a relevance score.

Scoring guide:
- 0.9-1.0: Directly answers or is essential to the query
- 0.7-0.8: Highly relevant, provides important context
- 0.5-0.6: Moderately relevant, tangentially useful
- 0.3-0.4: Weakly relevant, only loosely connected
- 0.0-0.2: Not relevant to this query (false positive from embedding search)

Rules:
- Judge semantic relevance, not just keyword overlap
- Consider the anchor context — items from a relevant anchor cluster are more likely relevant
- Be strict: embedding search produces false positives; your job is to filter them
- Every candidate MUST appear in your response with a score
- Keep reasons very brief (under 10 words) or omit them

Respond with ONLY a JSON object:
{
  "scores": [
    { "id": "<item-id>", "relevance": 0.85, "reason": "Directly addresses query topic" },
    { "id": "<item-id>", "relevance": 0.2, "reason": "Unrelated" }
  ]
}`;

// ─── Prompt Builder ──────────────────────────────────────────────

/**
 * Build the user prompt for LLM re-ranking.
 */
function buildUserPrompt(input: RerankInput): string {
  const parts: string[] = [];

  parts.push(`<query>${input.query}</query>`);
  parts.push('');
  parts.push('<candidates>');

  for (const c of input.candidates) {
    const anchor = c.anchorLabel ? ` [via anchor: "${c.anchorLabel}"]` : '';
    parts.push(
      `- id="${c.id}" type="${c.nodeType}"${anchor} coarseScore=${c.coarseScore.toFixed(3)}`,
    );
    parts.push(`  "${c.content.slice(0, 300)}"`);
  }

  parts.push('</candidates>');
  parts.push('');
  parts.push('Re-rank these candidates by relevance to the query.');

  return parts.join('\n');
}

/**
 * Build a complete LLM completion request for re-ranking.
 */
export function buildRerankRequest(input: RerankInput): LLMCompletionRequest {
  return {
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    responseFormat: 'json',
    temperature: 0.1, // Very deterministic for consistent ranking
    maxTokens: 1024,
  };
}

/**
 * Parse the LLM's re-ranking JSON response.
 * Validates IDs against the candidate list to prevent hallucination.
 */
export function parseRerankResponse(
  raw: string,
  candidateIds: Set<string>,
): RerankResponse {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse rerank JSON: ${raw.slice(0, 200)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Rerank response is not an object');
  }

  const obj = parsed as Record<string, unknown>;
  const rawScores = Array.isArray(obj.scores) ? obj.scores : [];
  const scores: RerankScore[] = [];

  for (const s of rawScores) {
    if (!s || typeof s !== 'object') continue;
    const item = s as Record<string, unknown>;

    const id = String(item.id ?? '');
    if (!candidateIds.has(id)) continue; // Anti-hallucination: skip unknown IDs

    const relevance = clampScore(item.relevance);

    scores.push({
      id,
      relevance,
      reason: item.reason ? String(item.reason) : undefined,
    });
  }

  return { scores };
}

/**
 * Expose the system prompt for testing.
 */
export function getRerankSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

// ─── Internal ────────────────────────────────────────────────────

function clampScore(value: unknown): number {
  const n = Number(value);
  if (isNaN(n)) return 0.0;
  return Math.max(0, Math.min(1, n));
}
