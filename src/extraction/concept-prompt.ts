/**
 * Concept Extraction Prompt — generates structured prompts for LLM-based
 * concept extraction from complete conversations (batch, post-conversation).
 *
 * Concepts are abstract topics, technologies, patterns, or domain terms
 * that recur or play a central role in conversations.
 */

import type { LLMCompletionRequest } from './llm-provider.js';

/** Input for concept extraction — a full conversation's messages + existing facts */
export interface ConceptExtractionInput {
  /** The conversation ID being processed */
  conversationId: string;
  /** All messages in the conversation, in order */
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
  /** Previously extracted facts from this conversation (for grounding) */
  existingFacts?: Array<{
    content: string;
    category: string;
    entities: string[];
  }>;
  /** Previously known concepts (to merge rather than duplicate) */
  existingConcepts?: Array<{
    name: string;
    aliases: string[];
    category: string;
  }>;
}

/** Raw concept extracted from LLM before ID assignment */
export interface ExtractedConcept {
  /** Canonical name of the concept */
  name: string;
  /** Brief description of what this concept means in context */
  description: string;
  /** Alternative names, abbreviations, or synonyms */
  aliases: string[];
  /** Category/domain classification */
  category: ConceptCategory;
  /** Relevance score: how central is this concept to the conversation (0-1) */
  relevance: number;
  /** Related concept names (for edge creation) */
  relatedConcepts: string[];
}

export type ConceptCategory =
  | 'technology'       // Programming languages, frameworks, tools, libraries
  | 'architecture'     // Design patterns, architectural styles, paradigms
  | 'domain'           // Domain-specific terminology (finance, healthcare, etc.)
  | 'methodology'      // Development methodologies, processes, workflows
  | 'preference'       // User preferences, style choices, conventions
  | 'project'          // Project names, codebases, products
  | 'platform'         // Platforms, services, cloud providers
  | 'standard'         // Standards, protocols, specifications
  | 'other';           // Uncategorized concepts

export const CONCEPT_CATEGORIES: readonly ConceptCategory[] = [
  'technology',
  'architecture',
  'domain',
  'methodology',
  'preference',
  'project',
  'platform',
  'standard',
  'other',
] as const;

const SYSTEM_PROMPT = `You are a concept extraction engine. Your task is to identify key concepts, technologies, domain terms, and recurring themes from an AI conversation.

Rules:
1. Extract concepts that are CENTRAL to the conversation — not every mentioned word.
2. A concept must appear multiple times OR be a core topic of discussion to be extracted.
3. Use canonical names (e.g., "TypeScript" not "TS", "React" not "react.js"), but include aliases.
4. Merge related terms into a single concept with aliases (e.g., "PostgreSQL" with aliases ["Postgres", "PG"]).
5. Assign a relevance score: 1.0 for primary topics, 0.7-0.9 for important supporting concepts, 0.4-0.6 for mentioned but not central.
6. Identify relationships between extracted concepts (e.g., "TypeScript" relates to "Node.js").
7. If existing concepts are provided, reuse their canonical names to avoid duplicates.
8. Do NOT extract generic conversational concepts (e.g., "question", "answer", "code").

Categories:
- technology: Programming languages, frameworks, tools, libraries, databases
- architecture: Design patterns, architectural styles, paradigms (e.g., "microservices", "event-driven")
- domain: Domain-specific terminology (e.g., "hedging" in finance, "HIPAA" in healthcare)
- methodology: Development methodologies, processes, workflows (e.g., "TDD", "CI/CD")
- preference: User preferences, conventions, style choices (e.g., "functional style", "dark theme")
- project: Project names, codebases, products
- platform: Platforms, services, cloud providers (e.g., "AWS", "Vercel")
- standard: Standards, protocols, specifications (e.g., "REST", "OpenAPI", "HTTP/2")
- other: Concepts that don't fit other categories

Respond with ONLY a JSON object in this exact format:
{
  "concepts": [
    {
      "name": "TypeScript",
      "description": "Statically typed superset of JavaScript used as the primary language",
      "aliases": ["TS"],
      "category": "technology",
      "relevance": 0.95,
      "relatedConcepts": ["Node.js", "JavaScript"]
    }
  ]
}

If no meaningful concepts are found, return: {"concepts": []}`;

/**
 * Build the user prompt from a full conversation and optional context.
 */
function buildUserPrompt(input: ConceptExtractionInput): string {
  const parts: string[] = [];

  // Provide existing concepts for deduplication
  if (input.existingConcepts && input.existingConcepts.length > 0) {
    parts.push('<existing_concepts>');
    for (const c of input.existingConcepts) {
      parts.push(`- ${c.name} (${c.category})${c.aliases.length > 0 ? ` [aliases: ${c.aliases.join(', ')}]` : ''}`);
    }
    parts.push('</existing_concepts>\n');
  }

  // Provide extracted facts for grounding
  if (input.existingFacts && input.existingFacts.length > 0) {
    parts.push('<extracted_facts>');
    for (const f of input.existingFacts) {
      parts.push(`- [${f.category}] ${f.content} (entities: ${f.entities.join(', ')})`);
    }
    parts.push('</extracted_facts>\n');
  }

  // Full conversation
  parts.push('<conversation>');
  for (const msg of input.messages) {
    parts.push(`<${msg.role}>\n${msg.content}\n</${msg.role}>`);
  }
  parts.push('</conversation>');

  parts.push('\nExtract all key concepts, technologies, domain terms, and recurring themes from this conversation.');

  return parts.join('\n');
}

/**
 * Build a complete LLM completion request for concept extraction.
 */
export function buildConceptExtractionRequest(
  input: ConceptExtractionInput,
): LLMCompletionRequest {
  return {
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    responseFormat: 'json',
    temperature: 0.2,
    maxTokens: 4096,
  };
}

/**
 * Expose the system prompt for testing.
 */
export function getConceptExtractionSystemPrompt(): string {
  return SYSTEM_PROMPT;
}
