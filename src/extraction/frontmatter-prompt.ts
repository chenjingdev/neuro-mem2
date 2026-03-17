/**
 * Frontmatter & Summary Prompt — generates LLM prompts for creating
 * Level 0 frontmatter (one-line metadata) and Level 1 summary for facts.
 *
 * Level 0 (frontmatter): A compact JSON string containing category, keywords,
 *   timestamp hint, and a one-line label — designed for rapid scanning.
 * Level 1 (summary): A short 1-2 sentence summary of the fact in plain language.
 *
 * These are pre-generated at ingestion time so retrieval never needs to
 * call the LLM for display-level information.
 */

import type { LLMCompletionRequest } from './llm-provider.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structured Level 0 frontmatter produced by the LLM. */
export interface FactFrontmatter {
  /** One-line human-readable label (≤80 chars) */
  label: string;
  /** Primary category (should match FactCategory) */
  category: string;
  /** 2-5 salient keywords for coarse filtering */
  keywords: string[];
  /** Domain/topic area (e.g. "backend", "UI", "devops", "personal") */
  domain?: string;
  /** Importance hint: "high" | "medium" | "low" */
  importance?: 'high' | 'medium' | 'low';
}

/** Input for generating frontmatter + summary for a single fact. */
export interface FrontmatterInput {
  /** The fact's canonical content text */
  factContent: string;
  /** The fact's category (already extracted) */
  category: string;
  /** Named entities in the fact (already extracted) */
  entities: string[];
  /** Optional conversation context for better summary generation */
  conversationContext?: string;
}

/** Parsed result from the LLM response. */
export interface FrontmatterResult {
  /** Level 0: serialized frontmatter JSON string */
  frontmatter: string;
  /** Level 1: 1-2 sentence summary */
  summary: string;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a metadata indexer for a brain-like memory system. Given a factual statement, you produce two outputs:

1. **frontmatter** (Level 0): A compact JSON object for rapid scanning with these fields:
   - "label": A one-line human-readable label (≤80 characters) that captures the essence of the fact
   - "category": The primary semantic category (one of: preference, technical, requirement, decision, context, instruction, knowledge, relationship, other)
   - "keywords": An array of 2-5 salient keywords (lowercase, no duplicates) useful for coarse text filtering
   - "domain": Optional topic area (e.g. "backend", "frontend", "devops", "database", "personal", "workflow")
   - "importance": "high" for critical decisions/requirements, "medium" for useful context, "low" for minor details

2. **summary** (Level 1): A 1-2 sentence plain-language summary that is self-contained and understandable without the original conversation.

Rules:
- Keywords must be concrete and searchable — avoid generic words like "user", "system", "thing"
- The label should be scannable at a glance — think of it like a git commit subject line
- The summary should add context beyond what the label provides
- Do NOT hallucinate information beyond what the fact states
- Respond with ONLY a JSON object in the exact format specified below

Response format:
{
  "frontmatter": {
    "label": "Prefers TypeScript for backend services",
    "category": "preference",
    "keywords": ["typescript", "backend", "language-preference"],
    "domain": "backend",
    "importance": "medium"
  },
  "summary": "The user prefers TypeScript over JavaScript for backend development, citing type safety and better tooling support."
}`;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the user prompt for a single fact.
 */
function buildUserPrompt(input: FrontmatterInput): string {
  const parts: string[] = [];

  parts.push(`<fact>`);
  parts.push(input.factContent);
  parts.push(`</fact>`);

  if (input.category) {
    parts.push(`\nPre-assigned category: ${input.category}`);
  }

  if (input.entities.length > 0) {
    parts.push(`Entities: ${input.entities.join(', ')}`);
  }

  if (input.conversationContext) {
    parts.push(`\n<context>\n${input.conversationContext}\n</context>`);
  }

  parts.push(`\nGenerate the frontmatter and summary for this fact.`);

  return parts.join('\n');
}

/**
 * Build a complete LLM completion request for frontmatter + summary generation.
 */
export function buildFrontmatterRequest(
  input: FrontmatterInput,
): LLMCompletionRequest {
  return {
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    responseFormat: 'json',
    temperature: 0.1,
    maxTokens: 512,
  };
}

/**
 * Build a batch request for multiple facts (single LLM call).
 * More token-efficient than calling one-by-one for bulk ingestion.
 */
export function buildBatchFrontmatterRequest(
  inputs: FrontmatterInput[],
): LLMCompletionRequest {
  const factsBlock = inputs.map((input, i) => {
    const parts = [`<fact index="${i}">`];
    parts.push(input.factContent);
    parts.push(`</fact>`);
    if (input.category) parts.push(`Category: ${input.category}`);
    if (input.entities.length > 0) parts.push(`Entities: ${input.entities.join(', ')}`);
    return parts.join('\n');
  }).join('\n\n');

  const batchPrompt = `${factsBlock}

Generate frontmatter and summary for each fact. Respond with a JSON object:
{
  "results": [
    { "frontmatter": { ... }, "summary": "..." },
    ...
  ]
}
The results array must have exactly ${inputs.length} items in the same order as the facts.`;

  return {
    system: SYSTEM_PROMPT,
    prompt: batchPrompt,
    responseFormat: 'json',
    temperature: 0.1,
    maxTokens: 512 * inputs.length,
  };
}

/**
 * Expose the system prompt for testing.
 */
export function getFrontmatterSystemPrompt(): string {
  return SYSTEM_PROMPT;
}
