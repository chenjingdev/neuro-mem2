/**
 * Fact Extraction Prompt — generates structured prompts for LLM-based
 * fact extraction from conversation turns.
 */

import type { FactExtractionInput } from '../models/fact.js';
import type { LLMCompletionRequest } from './llm-provider.js';

const SYSTEM_PROMPT = `You are a precise fact extraction engine. Your task is to extract atomic, structured facts from AI conversation turns.

Rules:
1. Extract ONLY factual information explicitly stated or clearly implied in the conversation.
2. Each fact must be a single, atomic statement — no compound facts.
3. Write facts in canonical, context-independent form (understandable without the original conversation).
4. Assign a confidence score: 1.0 for explicitly stated, 0.7-0.9 for strongly implied, 0.5-0.6 for loosely implied.
5. Identify all named entities (people, technologies, projects, concepts) referenced in each fact.
6. Categorize each fact into exactly one category.
7. Do NOT extract greetings, filler, or purely conversational statements.
8. Do NOT hallucinate or infer beyond what the text supports.

Categories:
- preference: User preferences, likes, dislikes, style choices
- technical: Technical decisions, stack/tool choices, architecture patterns
- requirement: Project requirements, constraints, acceptance criteria
- decision: Explicit decisions made during the conversation
- context: Background context, project info, environment details
- instruction: Standing instructions, conventions, rules to follow
- knowledge: Domain knowledge shared, confirmed, or corrected
- relationship: Relationships between entities, concepts, or systems
- other: Facts that don't fit other categories

For each fact, optionally extract a subject-predicate-object triple to enable graph-based retrieval:
- subject: The entity the fact is about (e.g., "user", "project", a specific name)
- predicate: The relationship or property (e.g., "prefers", "uses", "requires")
- object: The value or target (e.g., "TypeScript", "PostgreSQL")

Respond with ONLY a JSON object in this exact format:
{
  "facts": [
    {
      "content": "The user prefers TypeScript over JavaScript for backend development",
      "category": "preference",
      "confidence": 0.95,
      "entities": ["TypeScript", "JavaScript"],
      "subject": "user",
      "predicate": "prefers",
      "object": "TypeScript"
    }
  ]
}

If no extractable facts exist, return: {"facts": []}`;

/**
 * Build the user prompt from a conversation turn.
 */
function buildUserPrompt(input: FactExtractionInput): string {
  const parts: string[] = [];

  if (input.priorContext) {
    parts.push(`<prior_context>\n${input.priorContext}\n</prior_context>\n`);
  }

  parts.push(`<conversation_turn>`);
  parts.push(`<user_message>\n${input.userMessage.content}\n</user_message>`);
  parts.push(`<assistant_message>\n${input.assistantMessage.content}\n</assistant_message>`);
  parts.push(`</conversation_turn>`);
  parts.push(`\nExtract all atomic facts from this conversation turn.`);

  return parts.join('\n');
}

/**
 * Build a complete LLM completion request for fact extraction.
 */
export function buildFactExtractionRequest(
  input: FactExtractionInput,
): LLMCompletionRequest {
  return {
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    responseFormat: 'json',
    temperature: 0.1,
    maxTokens: 2048,
  };
}

/**
 * Expose the system prompt for testing.
 */
export function getFactExtractionSystemPrompt(): string {
  return SYSTEM_PROMPT;
}
