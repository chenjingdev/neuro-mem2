/**
 * Anchor Judgment Prompt — generates LLM prompts for deciding whether to
 * connect a fact to existing anchors or create new ones.
 *
 * This is a key part of the brain-like memory pipeline: the LLM acts as
 * a "binding judge" that decides how new information connects to existing
 * semantic hubs (anchors). Unlike pure RAG, this creates associative
 * links that enable recall-by-association rather than just keyword matching.
 *
 * Pipeline position:
 *   FactIngestionPipeline → AnchorCandidateFinder (coarse filter) →
 *   **AnchorJudgment (LLM decision)** → edge creation / anchor creation
 */

import type { LLMCompletionRequest } from './llm-provider.js';
import type { AnchorCandidate } from '../services/anchor-candidate-finder.js';

// ─── Types ───────────────────────────────────────────────────────

/** Input for the anchor judgment LLM call. */
export interface AnchorJudgmentInput {
  /** The fact's canonical content text */
  factContent: string;
  /** The fact's category */
  factCategory: string;
  /** Named entities in the fact */
  factEntities: string[];
  /** Level 0 frontmatter (if available) */
  factFrontmatter?: string;
  /** Candidate anchors found by embedding similarity (coarse filter) */
  candidates: AnchorCandidate[];
}

/**
 * A single anchor decision from the LLM.
 * Either connects to an existing anchor or requests creation of a new one.
 */
export type AnchorDecision =
  | AnchorConnectDecision
  | AnchorCreateDecision;

/** Decision to connect fact to an existing anchor. */
export interface AnchorConnectDecision {
  action: 'connect';
  /** ID of the existing anchor to connect to */
  anchorId: string;
  /** Semantic relationship strength [0.0-1.0] */
  strength: number;
  /** Brief reason for the connection */
  reason: string;
}

/** Decision to create a new anchor and connect the fact to it. */
export interface AnchorCreateDecision {
  action: 'create';
  /** Suggested label for the new anchor */
  label: string;
  /** Description of the anchor's semantic scope */
  description: string;
  /** Suggested anchor type */
  anchorType: 'entity' | 'topic' | 'temporal' | 'composite';
  /** Initial connection strength [0.0-1.0] */
  strength: number;
  /** Brief reason for creating this anchor */
  reason: string;
}

/** Expected JSON structure from the LLM response. */
export interface AnchorJudgmentResponse {
  /** List of decisions (connect to existing or create new) */
  decisions: AnchorDecision[];
  /**
   * Whether the fact is "isolated" — not meaningfully connected to any anchor.
   * If true, decisions may be empty or contain only a weak create suggestion.
   */
  isolated: boolean;
}

// ─── System Prompt ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a memory binding judge for a brain-like memory system. Your role is to decide how a new fact connects to existing semantic anchors (hub nodes), or whether a new anchor should be created.

Anchors are semantic hub nodes that group related memories around a theme, entity, or topic. Think of them like neurons that fire together — when an anchor is activated during recall, all connected memories become accessible through association.

You will receive:
1. A new fact to integrate into the memory graph
2. A list of candidate anchors (found by embedding similarity) with their labels, descriptions, types, and similarity scores

Your job is to decide, for each relevant anchor:
- **connect**: Link the fact to this existing anchor (the fact is semantically related to this anchor's scope)
- **create**: Suggest a new anchor (the fact introduces a concept not covered by existing anchors)

Rules:
- A fact can connect to MULTIPLE existing anchors (memories are multi-dimensional)
- Only suggest "create" when the fact genuinely introduces a new semantic theme not covered by candidates
- Do NOT create an anchor that duplicates an existing candidate — prefer connecting
- Connection strength: 0.8-1.0 = core/defining, 0.5-0.7 = clearly related, 0.3-0.4 = tangentially related
- Prefer fewer, higher-quality connections over many weak ones
- If no candidates are relevant AND the fact is too trivial/specific for an anchor, set isolated=true
- New anchor types: "entity" for named things, "topic" for themes/domains, "temporal" for time-bound clusters, "composite" for multi-theme anchors
- Labels should be concise (2-5 words), descriptions should define the anchor's semantic scope

Respond with ONLY a JSON object in this exact format:
{
  "decisions": [
    {
      "action": "connect",
      "anchorId": "<existing anchor ID>",
      "strength": 0.7,
      "reason": "Brief explanation"
    },
    {
      "action": "create",
      "label": "New Anchor Label",
      "description": "What this anchor represents and groups together",
      "anchorType": "topic",
      "strength": 0.8,
      "reason": "Brief explanation"
    }
  ],
  "isolated": false
}`;

// ─── Prompt Builders ─────────────────────────────────────────────

/**
 * Build the user prompt for anchor judgment.
 */
function buildUserPrompt(input: AnchorJudgmentInput): string {
  const parts: string[] = [];

  // Fact section
  parts.push('<fact>');
  parts.push(input.factContent);
  parts.push('</fact>');

  if (input.factCategory) {
    parts.push(`\nCategory: ${input.factCategory}`);
  }
  if (input.factEntities.length > 0) {
    parts.push(`Entities: ${input.factEntities.join(', ')}`);
  }
  if (input.factFrontmatter) {
    parts.push(`Frontmatter: ${input.factFrontmatter}`);
  }

  // Candidate anchors section
  if (input.candidates.length > 0) {
    parts.push('\n<candidate_anchors>');
    for (const c of input.candidates) {
      parts.push(
        `- id="${c.anchorId}" label="${c.label}" type="${c.anchorType}" ` +
        `similarity=${c.similarity.toFixed(3)} ` +
        `description="${c.description}"`,
      );
    }
    parts.push('</candidate_anchors>');
  } else {
    parts.push('\n<candidate_anchors>');
    parts.push('No existing anchors found by embedding similarity.');
    parts.push('</candidate_anchors>');
  }

  parts.push('\nDecide how this fact connects to the memory graph.');

  return parts.join('\n');
}

/**
 * Build a complete LLM completion request for anchor judgment.
 */
export function buildAnchorJudgmentRequest(
  input: AnchorJudgmentInput,
): LLMCompletionRequest {
  return {
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    responseFormat: 'json',
    temperature: 0.2, // Slightly higher than 0.1 for nuanced judgment
    maxTokens: 1024,
  };
}

/**
 * Expose the system prompt for testing.
 */
export function getAnchorJudgmentSystemPrompt(): string {
  return SYSTEM_PROMPT;
}
