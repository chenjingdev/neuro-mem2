/**
 * Memory Node Extraction Prompt — unified prompt for extracting MemoryNodes
 * from conversation turns in a single LLM call.
 *
 * Key design:
 * - Extracts ALL nodeTypes (semantic, episodic, procedural, prospective, emotional) at once
 * - Each node includes searchKeywords (한영 혼용) and relatedEntities
 * - Single LLM call per turn (1-call budget constraint)
 */

import type { LLMCompletionRequest } from './llm-provider.js';

// ─── Input ───────────────────────────────────────────────────────

export interface MemoryNodeExtractionInput {
  /** Conversation ID */
  conversationId: string;
  /** User message content */
  userMessage: {
    content: string;
    turnIndex: number;
  };
  /** Assistant message content */
  assistantMessage: {
    content: string;
    turnIndex: number;
  };
  /** Optional prior context (recent conversation history) */
  priorContext?: string;
}

// ─── System Prompt ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a memory extraction engine for a personal knowledge management system.
Your task: extract structured memory nodes from a conversation turn.

For EACH extracted node, you MUST provide:

1. **nodeType** — classify the memory:
   - "semantic": Factual knowledge, definitions, preferences, decisions (e.g., "User prefers TypeScript")
   - "episodic": An event or experience that happened (e.g., "Deployed v2.0 to production")
   - "procedural": How-to knowledge, workflows, steps (e.g., "To deploy: run build, then push")
   - "prospective": Future plans, goals, TODOs (e.g., "Plans to migrate to PostgreSQL next week")
   - "emotional": Emotional context or sentiment (e.g., "User frustrated with build times")

2. **frontmatter** — a concise one-line label (max 80 chars) summarizing the node

3. **summary** — a 1-3 sentence canonical description, context-independent (understandable without the original conversation)

4. **searchKeywords** — an array of 3-8 search keywords for full-text retrieval:
   - Include BOTH Korean and English terms when the conversation is bilingual (한영 혼용)
   - Include synonyms and related terms that a user might search for
   - Include specific technical terms, project names, tool names
   - Example: ["TypeScript", "타입스크립트", "backend", "백엔드", "language preference"]

5. **relatedEntities** — an array of named entities referenced in this node:
   - People, organizations, projects, technologies, concepts, locations
   - Use canonical forms (e.g., "TypeScript" not "TS", "React" not "react.js")
   - These are used for hub matching and relationship graph building
   - Example: ["TypeScript", "JavaScript", "Node.js", "user"]

6. **metadata** — type-dependent structured fields:
   - For semantic: { category, confidence, subject, predicate, object }
   - For episodic: { episodeType, actors, outcome }
   - For procedural: { steps, prerequisites }
   - For prospective: { priority, status, dueDate }
   - For emotional: { emotion, intensity, trigger }
   - category: one of "preference", "technical", "requirement", "decision", "context", "instruction", "knowledge", "relationship", "other"
   - confidence: 1.0 (explicit) / 0.7-0.9 (strongly implied) / 0.5-0.6 (loosely implied)

Rules:
- Extract ALL noteworthy information — do not skip facts, plans, or emotional context.
- Each node MUST be atomic (one idea per node). Split compound statements.
- Write summaries in canonical, context-independent form.
- Do NOT extract greetings, filler, or purely conversational pleasantries.
- Do NOT hallucinate — only extract what the text supports.
- searchKeywords MUST include terms in ALL languages used in the conversation.
- relatedEntities MUST use canonical entity names (proper casing, full names).

Respond with ONLY a JSON object:
{
  "nodes": [
    {
      "nodeType": "semantic",
      "frontmatter": "User prefers TypeScript for backend",
      "summary": "The user prefers TypeScript over JavaScript for backend development due to type safety.",
      "searchKeywords": ["TypeScript", "타입스크립트", "backend", "백엔드", "type safety", "language preference"],
      "relatedEntities": ["TypeScript", "JavaScript"],
      "metadata": {
        "category": "preference",
        "confidence": 0.95,
        "subject": "user",
        "predicate": "prefers",
        "object": "TypeScript"
      }
    }
  ]
}

If no extractable memory exists, return: {"nodes": []}`;

// ─── Prompt Builder ──────────────────────────────────────────────

function buildUserPrompt(input: MemoryNodeExtractionInput): string {
  const parts: string[] = [];

  if (input.priorContext) {
    parts.push(`<prior_context>\n${input.priorContext}\n</prior_context>\n`);
  }

  parts.push(`<conversation_turn>`);
  parts.push(`<user_message>\n${input.userMessage.content}\n</user_message>`);
  parts.push(`<assistant_message>\n${input.assistantMessage.content}\n</assistant_message>`);
  parts.push(`</conversation_turn>`);
  parts.push(`\nExtract all memory nodes from this conversation turn. Include searchKeywords (한영 혼용 if bilingual) and relatedEntities for each node.`);

  return parts.join('\n');
}

/**
 * Build a complete LLM completion request for unified memory node extraction.
 */
export function buildMemoryNodeExtractionRequest(
  input: MemoryNodeExtractionInput,
): LLMCompletionRequest {
  return {
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    responseFormat: 'json',
    temperature: 0.1,
    maxTokens: 4096,
  };
}

/**
 * Expose the system prompt for testing.
 */
export function getMemoryNodeExtractionSystemPrompt(): string {
  return SYSTEM_PROMPT;
}
