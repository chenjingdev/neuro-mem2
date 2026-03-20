import { describe, it, expect, beforeEach } from 'vitest';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import { FactExtractor } from '../src/extraction/fact-extractor.js';
import { parseFactResponse } from '../src/extraction/fact-parser.js';
import { buildFactExtractionRequest, getFactExtractionSystemPrompt } from '../src/extraction/fact-prompt.js';
import type { FactExtractionInput } from '../src/models/fact.js';

/**
 * Helper to create a standard extraction input.
 */
function makeInput(overrides?: Partial<FactExtractionInput>): FactExtractionInput {
  return {
    conversationId: 'conv-1',
    userMessage: {
      content: 'I prefer TypeScript for backend work and use PostgreSQL for production databases.',
      turnIndex: 0,
    },
    assistantMessage: {
      content: 'Great choices! TypeScript provides strong typing for backend development, and PostgreSQL is excellent for production workloads.',
      turnIndex: 1,
    },
    ...overrides,
  };
}

/**
 * A realistic LLM response with multiple facts.
 */
const GOOD_RESPONSE = JSON.stringify({
  facts: [
    {
      content: 'The user prefers TypeScript for backend development',
      category: 'preference',
      confidence: 0.95,
      entities: ['TypeScript'],
    },
    {
      content: 'The user uses PostgreSQL for production databases',
      category: 'technical',
      confidence: 0.95,
      entities: ['PostgreSQL'],
    },
  ],
});

describe('Fact Parser', () => {
  it('should parse a well-formed JSON response', () => {
    const result = parseFactResponse(GOOD_RESPONSE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts).toHaveLength(2);
      expect(result.facts[0]!.content).toBe('The user prefers TypeScript for backend development');
      expect(result.facts[0]!.category).toBe('preference');
      expect(result.facts[0]!.confidence).toBe(0.95);
      expect(result.facts[0]!.entities).toEqual(['TypeScript']);
    }
  });

  it('should handle markdown-fenced JSON', () => {
    const wrapped = '```json\n' + GOOD_RESPONSE + '\n```';
    const result = parseFactResponse(wrapped);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts).toHaveLength(2);
    }
  });

  it('should handle JSON with surrounding text', () => {
    const noisy = 'Here are the extracted facts:\n' + GOOD_RESPONSE + '\n\nLet me know if you need more.';
    const result = parseFactResponse(noisy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts).toHaveLength(2);
    }
  });

  it('should handle bare array format', () => {
    const bare = JSON.stringify([
      { content: 'A fact', category: 'context', confidence: 0.8, entities: [] },
    ]);
    const result = parseFactResponse(bare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts).toHaveLength(1);
    }
  });

  it('should return empty facts for empty response', () => {
    const result = parseFactResponse('');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts).toHaveLength(0);
    }
  });

  it('should return empty facts for {"facts": []}', () => {
    const result = parseFactResponse('{"facts": []}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts).toHaveLength(0);
    }
  });

  it('should return error for completely invalid content', () => {
    const result = parseFactResponse('This is not JSON at all, no braces here');
    expect(result.ok).toBe(false);
  });

  it('should skip facts with empty content', () => {
    const response = JSON.stringify({
      facts: [
        { content: '', category: 'context', confidence: 0.8, entities: [] },
        { content: 'Valid fact', category: 'context', confidence: 0.8, entities: [] },
      ],
    });
    const result = parseFactResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]!.content).toBe('Valid fact');
    }
  });

  it('should normalize unknown categories to "other"', () => {
    const response = JSON.stringify({
      facts: [
        { content: 'A fact', category: 'unknown_cat', confidence: 0.8, entities: [] },
      ],
    });
    const result = parseFactResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts[0]!.category).toBe('other');
    }
  });

  it('should clamp confidence to [0, 1]', () => {
    const response = JSON.stringify({
      facts: [
        { content: 'Over confident', category: 'context', confidence: 1.5, entities: [] },
        { content: 'Negative confidence', category: 'context', confidence: -0.3, entities: [] },
      ],
    });
    const result = parseFactResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts[0]!.confidence).toBe(1.0);
      expect(result.facts[1]!.confidence).toBe(0);
    }
  });

  it('should default confidence to 0.5 for non-numeric values', () => {
    const response = JSON.stringify({
      facts: [
        { content: 'No confidence', category: 'context', confidence: 'high', entities: [] },
      ],
    });
    const result = parseFactResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts[0]!.confidence).toBe(0.5);
    }
  });

  it('should filter non-string entities', () => {
    const response = JSON.stringify({
      facts: [
        { content: 'A fact', category: 'context', confidence: 0.8, entities: ['valid', 123, null, 'also valid', ''] },
      ],
    });
    const result = parseFactResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts[0]!.entities).toEqual(['valid', 'also valid']);
    }
  });

  it('should handle missing entities field', () => {
    const response = JSON.stringify({
      facts: [
        { content: 'No entities field', category: 'context', confidence: 0.8 },
      ],
    });
    const result = parseFactResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts[0]!.entities).toEqual([]);
    }
  });

  it('should parse subject/predicate/object triples', () => {
    const response = JSON.stringify({
      facts: [
        {
          content: 'The user prefers TypeScript',
          category: 'preference',
          confidence: 0.95,
          entities: ['TypeScript'],
          subject: 'user',
          predicate: 'prefers',
          object: 'TypeScript',
        },
      ],
    });
    const result = parseFactResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts[0]!.subject).toBe('user');
      expect(result.facts[0]!.predicate).toBe('prefers');
      expect(result.facts[0]!.object).toBe('TypeScript');
    }
  });

  it('should handle missing subject/predicate/object gracefully', () => {
    const response = JSON.stringify({
      facts: [
        { content: 'A fact without triple', category: 'context', confidence: 0.8, entities: [] },
      ],
    });
    const result = parseFactResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts[0]!.subject).toBeUndefined();
      expect(result.facts[0]!.predicate).toBeUndefined();
      expect(result.facts[0]!.object).toBeUndefined();
    }
  });
});

describe('Fact Extraction Prompt', () => {
  it('should build a request with system and user prompts', () => {
    const input = makeInput();
    const request = buildFactExtractionRequest(input);

    expect(request.system).toBeTruthy();
    expect(request.prompt).toContain('I prefer TypeScript');
    expect(request.prompt).toContain('Great choices!');
    expect(request.responseFormat).toBe('json');
    expect(request.temperature).toBe(0.1);
  });

  it('should include prior context when provided', () => {
    const input = makeInput({ priorContext: 'The user is building a web application.' });
    const request = buildFactExtractionRequest(input);

    expect(request.prompt).toContain('<prior_context>');
    expect(request.prompt).toContain('The user is building a web application.');
  });

  it('should not include prior context tags when not provided', () => {
    const input = makeInput();
    const request = buildFactExtractionRequest(input);

    expect(request.prompt).not.toContain('<prior_context>');
  });

  it('should use XML tags for structured message formatting', () => {
    const input = makeInput();
    const request = buildFactExtractionRequest(input);

    expect(request.prompt).toContain('<user_message>');
    expect(request.prompt).toContain('</user_message>');
    expect(request.prompt).toContain('<assistant_message>');
    expect(request.prompt).toContain('</assistant_message>');
    expect(request.prompt).toContain('<conversation_turn>');
  });

  it('should have system prompt with all fact categories', () => {
    const systemPrompt = getFactExtractionSystemPrompt();
    expect(systemPrompt).toContain('preference');
    expect(systemPrompt).toContain('technical');
    expect(systemPrompt).toContain('requirement');
    expect(systemPrompt).toContain('decision');
    expect(systemPrompt).toContain('context');
    expect(systemPrompt).toContain('instruction');
    expect(systemPrompt).toContain('knowledge');
    expect(systemPrompt).toContain('relationship');
  });
});

describe('Fact Extractor', () => {
  let provider: MockLLMProvider;
  let extractor: FactExtractor;

  beforeEach(() => {
    provider = new MockLLMProvider();
    extractor = new FactExtractor(provider);
  });

  it('should extract facts from a conversation turn via LLM', async () => {
    provider.addResponse(GOOD_RESPONSE);
    const input = makeInput();

    const result = await extractor.extractFromTurn(input);

    expect(result.ok).toBe(true);
    expect(result.facts).toHaveLength(2);

    // Verify IDs are assigned
    expect(result.facts[0]!.id).toBeTruthy();
    expect(result.facts[1]!.id).toBeTruthy();
    expect(result.facts[0]!.id).not.toBe(result.facts[1]!.id);

    // Verify conversation and source linkage
    expect(result.facts[0]!.conversationId).toBe('conv-1');
    expect(result.facts[0]!.sourceMessageIds).toEqual(['conv-1:0', 'conv-1:1']);

    // Verify metadata
    expect(result.facts[0]!.metadata?.extractionModel).toBe('mock');
    expect(result.facts[0]!.createdAt).toBeTruthy();
  });

  it('should pass correct prompt to LLM provider', async () => {
    provider.addResponse('{"facts": []}');
    const input = makeInput();

    await extractor.extractFromTurn(input);

    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0]!;
    expect(call.system).toBeTruthy();
    expect(call.prompt).toContain('I prefer TypeScript');
    expect(call.responseFormat).toBe('json');
  });

  it('should return empty facts for empty messages', async () => {
    const input = makeInput({
      userMessage: { content: '  ', turnIndex: 0 },
      assistantMessage: { content: 'response', turnIndex: 1 },
    });

    const result = await extractor.extractFromTurn(input);
    expect(result.ok).toBe(true);
    expect(result.facts).toHaveLength(0);
    // Should not have called the LLM
    expect(provider.calls).toHaveLength(0);
  });

  it('should handle LLM parse errors gracefully', async () => {
    provider.addResponse('Not valid JSON at all!!');
    const input = makeInput();

    const result = await extractor.extractFromTurn(input);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('JSON parse error');
    expect(result.rawResponse).toBe('Not valid JSON at all!!');
  });

  it('should handle LLM provider errors gracefully', async () => {
    const failProvider: MockLLMProvider = {
      name: 'fail-mock',
      calls: [],
      addResponse: () => {},
      reset: () => {},
      async complete() {
        throw new Error('API rate limit exceeded');
      },
    } as unknown as MockLLMProvider;

    const failExtractor = new FactExtractor(failProvider);
    const input = makeInput();

    const result = await failExtractor.extractFromTurn(input);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('API rate limit exceeded');
  });

  it('should extract from multiple turns in sequence', async () => {
    provider.addResponse(JSON.stringify({
      facts: [{ content: 'Fact from turn 1', category: 'context', confidence: 0.9, entities: [] }],
    }));
    provider.addResponse(JSON.stringify({
      facts: [{ content: 'Fact from turn 2', category: 'technical', confidence: 0.85, entities: ['React'] }],
    }));

    const inputs = [
      makeInput({ conversationId: 'c1' }),
      makeInput({
        conversationId: 'c1',
        userMessage: { content: 'We should use React for the frontend', turnIndex: 2 },
        assistantMessage: { content: 'React is a great choice for interactive UIs.', turnIndex: 3 },
      }),
    ];

    const results = await extractor.extractFromTurns(inputs);

    expect(results).toHaveLength(2);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.facts[0]!.content).toBe('Fact from turn 1');
    expect(results[1]!.ok).toBe(true);
    expect(results[1]!.facts[0]!.content).toBe('Fact from turn 2');
    expect(results[1]!.facts[0]!.entities).toEqual(['React']);
  });

  it('should handle LLM returning no facts gracefully', async () => {
    provider.addResponse('{"facts": []}');
    const input = makeInput();

    const result = await extractor.extractFromTurn(input);
    expect(result.ok).toBe(true);
    expect(result.facts).toHaveLength(0);
  });

  it('should handle markdown-wrapped LLM response', async () => {
    provider.addResponse('```json\n' + GOOD_RESPONSE + '\n```');
    const input = makeInput();

    const result = await extractor.extractFromTurn(input);
    expect(result.ok).toBe(true);
    expect(result.facts).toHaveLength(2);
  });

  it('should set sourceTurnIndex, superseded, and updatedAt on extracted facts', async () => {
    provider.addResponse(GOOD_RESPONSE);
    const input = makeInput();

    const result = await extractor.extractFromTurn(input);

    expect(result.ok).toBe(true);
    expect(result.facts[0]!.sourceTurnIndex).toBe(0);
    expect(result.facts[0]!.superseded).toBe(false);
    expect(result.facts[0]!.updatedAt).toBeTruthy();
  });

  it('should propagate subject/predicate/object from LLM response', async () => {
    const responseWithTriple = JSON.stringify({
      facts: [
        {
          content: 'The user prefers TypeScript for backend development',
          category: 'preference',
          confidence: 0.95,
          entities: ['TypeScript'],
          subject: 'user',
          predicate: 'prefers',
          object: 'TypeScript',
        },
      ],
    });
    provider.addResponse(responseWithTriple);
    const input = makeInput();

    const result = await extractor.extractFromTurn(input);

    expect(result.ok).toBe(true);
    expect(result.facts[0]!.subject).toBe('user');
    expect(result.facts[0]!.predicate).toBe('prefers');
    expect(result.facts[0]!.object).toBe('TypeScript');
  });
});
