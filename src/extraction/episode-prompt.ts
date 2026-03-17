/**
 * Episode extraction prompt builder.
 *
 * Constructs LLM prompts for batch episode extraction from conversations.
 * Episodes are chronological units of activity (actions, decisions, events, discoveries).
 */

import type { LLMCompletionRequest } from './llm-provider.js';
import type { RawMessage } from '../models/conversation.js';

const SYSTEM_PROMPT = `You are an expert at analyzing conversations and extracting structured episodes from them.

An episode is a discrete unit of activity that occurred during the conversation. Episodes are chronological and may overlap in the turns they cover.

Episode types:
- "action": Something the user or assistant did (wrote code, executed a command, deployed, etc.)
- "decision": A choice or decision made (chose a technology, picked an approach, etc.)
- "event": An external event referenced or that occurred (build failed, test passed, PR merged, etc.)
- "discovery": New information learned or uncovered (found a bug, identified root cause, realized a constraint, etc.)

For each episode, extract:
- type: one of "action", "decision", "event", "discovery"
- title: a concise title (max 80 chars)
- description: detailed description of what happened (1-3 sentences)
- startTurnIndex: the 0-based index of the first message turn where this episode begins
- endTurnIndex: the 0-based index of the last message turn where this episode ends
- actors: list of actors involved (e.g., ["user"], ["assistant"], ["user", "assistant"], ["CI system"])
- outcome: the result/outcome if applicable, otherwise omit

IMPORTANT RULES:
1. Episodes MUST be ordered chronologically by startTurnIndex
2. Turn indices MUST be valid (within the range of the conversation)
3. startTurnIndex MUST be <= endTurnIndex
4. Extract meaningful episodes only — skip trivial greetings or filler
5. Each episode should represent a distinct, identifiable unit of activity

Respond with ONLY a JSON array of episode objects. No markdown, no explanation.`;

/**
 * Build the user prompt from conversation messages.
 */
function buildUserPrompt(messages: RawMessage[], maxEpisodes?: number): string {
  const turnLines = messages.map(
    (m) => `[Turn ${m.turnIndex}] ${m.role}: ${m.content}`
  );

  const limitNote = maxEpisodes
    ? `\nExtract at most ${maxEpisodes} episodes.`
    : '';

  return `Analyze the following conversation and extract episodes:

${turnLines.join('\n\n')}
${limitNote}
Respond with a JSON array of episodes.`;
}

/**
 * Build the LLM completion request for episode extraction.
 */
export function buildEpisodeExtractionRequest(
  messages: RawMessage[],
  maxEpisodes?: number,
): LLMCompletionRequest {
  return {
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(messages, maxEpisodes),
    responseFormat: 'json',
    temperature: 0,
    maxTokens: 4096,
  };
}

/**
 * Export system prompt for testing.
 */
export function getEpisodeExtractionSystemPrompt(): string {
  return SYSTEM_PROMPT;
}
