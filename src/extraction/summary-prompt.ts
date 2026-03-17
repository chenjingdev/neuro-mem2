/**
 * Summary Prompt — generates structured prompts for LLM-based
 * Level 0 (frontmatter) and Level 1 (summary) generation from facts.
 *
 * Part of the brain-like memory pipeline: after fact extraction,
 * the LLM pre-generates compressed representations at two granularity levels
 * so retrieval can return the right detail level without re-processing.
 */

import type { LLMCompletionRequest } from './llm-provider.js';

/** Input for summary generation — one or more facts to summarize. */
export interface SummaryGenerationInput {
  /** Array of facts to generate summaries for */
  facts: Array<{
    /** Unique fact ID (passed through for result mapping) */
    id: string;
    /** The full fact content text */
    content: string;
    /** Semantic category (provides context for summarization) */
    category: string;
    /** Named entities (helps LLM focus the summary) */
    entities: string[];
  }>;
}

/** Result of summary generation for a single fact. */
export interface GeneratedSummary {
  /** Fact ID this summary belongs to */
  id: string;
  /** Level 0: one-line frontmatter label (≤15 words) */
  frontmatter: string;
  /** Level 1: short summary (1-2 sentences, ≤50 words) */
  summary: string;
}

const SYSTEM_PROMPT = `You are a precise summarization engine for a brain-like memory system. Your task is to generate two compression levels for each fact:

Level 0 — Frontmatter: A single-line label (≤15 words) for quick scanning. Think of it as a title or tag line. Use noun phrases or short declarative fragments, NOT full sentences.

Level 1 — Summary: A 1-2 sentence summary (≤50 words) that captures the essential meaning. Must be self-contained and understandable without the original context.

Rules:
1. Preserve all key entities and relationships from the original fact.
2. Do NOT add information not present in the original.
3. Do NOT use vague language — be specific and concrete.
4. Frontmatter should be a scannable label, NOT a sentence.
5. Summary must be strictly shorter than the original content.
6. If the fact is already very short (under 15 words), frontmatter = the fact itself, summary = the fact itself.

Respond with ONLY a JSON object in this exact format:
{
  "summaries": [
    {
      "id": "<fact_id>",
      "frontmatter": "TypeScript preference over JavaScript",
      "summary": "The user prefers TypeScript over JavaScript for backend development due to type safety."
    }
  ]
}`;

/**
 * Build the user prompt from facts to summarize.
 */
function buildUserPrompt(input: SummaryGenerationInput): string {
  const parts: string[] = [];

  parts.push('<facts_to_summarize>');
  for (const fact of input.facts) {
    parts.push(`<fact id="${fact.id}" category="${fact.category}">`);
    parts.push(fact.content);
    if (fact.entities.length > 0) {
      parts.push(`[entities: ${fact.entities.join(', ')}]`);
    }
    parts.push('</fact>');
  }
  parts.push('</facts_to_summarize>');
  parts.push(
    `\nGenerate frontmatter (Level 0) and summary (Level 1) for each fact above. Return exactly ${input.facts.length} summaries.`,
  );

  return parts.join('\n');
}

/**
 * Build a complete LLM completion request for summary generation.
 */
export function buildSummaryGenerationRequest(
  input: SummaryGenerationInput,
): LLMCompletionRequest {
  return {
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    responseFormat: 'json',
    temperature: 0.0, // deterministic for reproducible summaries
    maxTokens: 1024,
  };
}

/**
 * Build a request for a single fact (convenience wrapper).
 */
export function buildSingleFactSummaryRequest(
  factId: string,
  content: string,
  category: string,
  entities: string[] = [],
): LLMCompletionRequest {
  return buildSummaryGenerationRequest({
    facts: [{ id: factId, content, category, entities }],
  });
}

/**
 * Expose the system prompt for testing.
 */
export function getSummaryGenerationSystemPrompt(): string {
  return SYSTEM_PROMPT;
}
