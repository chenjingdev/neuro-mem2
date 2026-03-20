import { describe, it, expect, beforeEach } from 'vitest';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import { EpisodeExtractor } from '../src/extraction/episode-extractor.js';
import { parseEpisodeResponse } from '../src/extraction/episode-parser.js';
import { buildEpisodeExtractionRequest } from '../src/extraction/episode-prompt.js';
import type { RawConversation, RawMessage } from '../src/models/conversation.js';

/**
 * Helper: create a minimal RawConversation for testing.
 */
function makeConversation(
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  id = 'conv-1',
): RawConversation {
  const now = new Date().toISOString();
  return {
    id,
    source: 'test',
    createdAt: now,
    updatedAt: now,
    messages: messages.map((m, i) => ({
      conversationId: id,
      role: m.role,
      content: m.content,
      turnIndex: i,
      createdAt: now,
    })),
  };
}

/**
 * Helper: create a valid LLM response JSON for episodes.
 */
function makeLLMResponse(episodes: Array<Record<string, unknown>>): string {
  return JSON.stringify(episodes);
}

describe('Episode Extraction', () => {
  let llm: MockLLMProvider;
  let extractor: EpisodeExtractor;

  beforeEach(() => {
    llm = new MockLLMProvider();
    extractor = new EpisodeExtractor(llm);
  });

  describe('parseEpisodeResponse', () => {
    it('should parse a valid JSON array of episodes', () => {
      const json = makeLLMResponse([
        {
          type: 'action',
          title: 'Wrote a function',
          description: 'The user asked to write a helper function and the assistant wrote it.',
          startTurnIndex: 0,
          endTurnIndex: 1,
          actors: ['user', 'assistant'],
          outcome: 'Function created successfully',
        },
      ]);

      const result = parseEpisodeResponse(json, 3);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(1);
      expect(result.episodes[0].type).toBe('action');
      expect(result.episodes[0].title).toBe('Wrote a function');
      expect(result.episodes[0].actors).toEqual(['user', 'assistant']);
      expect(result.episodes[0].outcome).toBe('Function created successfully');
    });

    it('should handle markdown code fences', () => {
      const json = '```json\n' + makeLLMResponse([
        {
          type: 'decision',
          title: 'Chose TypeScript',
          description: 'Decided to use TypeScript for the project.',
          startTurnIndex: 0,
          endTurnIndex: 0,
          actors: ['user'],
        },
      ]) + '\n```';

      const result = parseEpisodeResponse(json, 2);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(1);
      expect(result.episodes[0].type).toBe('decision');
    });

    it('should skip episodes with invalid type', () => {
      const json = makeLLMResponse([
        {
          type: 'invalid_type',
          title: 'Bad episode',
          description: 'This should be skipped.',
          startTurnIndex: 0,
          endTurnIndex: 0,
          actors: ['user'],
        },
        {
          type: 'event',
          title: 'Valid episode',
          description: 'This should be kept.',
          startTurnIndex: 1,
          endTurnIndex: 1,
          actors: ['assistant'],
        },
      ]);

      const result = parseEpisodeResponse(json, 3);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(1);
      expect(result.episodes[0].type).toBe('event');
    });

    it('should skip episodes with missing required fields', () => {
      const json = makeLLMResponse([
        { type: 'action', description: 'No title', startTurnIndex: 0, endTurnIndex: 0, actors: ['user'] },
        { type: 'action', title: 'No description', startTurnIndex: 0, endTurnIndex: 0, actors: ['user'] },
        { type: 'action', title: 'No actors', description: 'desc', startTurnIndex: 0, endTurnIndex: 0 },
        { type: 'action', title: 'No turns', description: 'desc', actors: ['user'] },
      ]);

      const result = parseEpisodeResponse(json, 3);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(0);
    });

    it('should skip episodes with out-of-range turn indices', () => {
      const json = makeLLMResponse([
        {
          type: 'action',
          title: 'Out of range',
          description: 'Turn index exceeds max.',
          startTurnIndex: 0,
          endTurnIndex: 10, // maxTurnIndex is 3
          actors: ['user'],
        },
      ]);

      const result = parseEpisodeResponse(json, 3);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(0);
    });

    it('should skip episodes where startTurnIndex > endTurnIndex', () => {
      const json = makeLLMResponse([
        {
          type: 'action',
          title: 'Backwards',
          description: 'Start is after end.',
          startTurnIndex: 3,
          endTurnIndex: 1,
          actors: ['user'],
        },
      ]);

      const result = parseEpisodeResponse(json, 5);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(0);
    });

    it('should skip episodes with negative turn indices', () => {
      const json = makeLLMResponse([
        {
          type: 'action',
          title: 'Negative',
          description: 'Negative index.',
          startTurnIndex: -1,
          endTurnIndex: 0,
          actors: ['user'],
        },
      ]);

      const result = parseEpisodeResponse(json, 3);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(0);
    });

    it('should skip episodes with non-integer turn indices', () => {
      const json = makeLLMResponse([
        {
          type: 'action',
          title: 'Fractional',
          description: 'Non-integer index.',
          startTurnIndex: 0.5,
          endTurnIndex: 1.5,
          actors: ['user'],
        },
      ]);

      const result = parseEpisodeResponse(json, 3);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(0);
    });

    it('should skip episodes with empty actors', () => {
      const json = makeLLMResponse([
        {
          type: 'action',
          title: 'No actors',
          description: 'Empty actors array.',
          startTurnIndex: 0,
          endTurnIndex: 0,
          actors: [],
        },
      ]);

      const result = parseEpisodeResponse(json, 3);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(0);
    });

    it('should filter out empty/invalid actor strings', () => {
      const json = makeLLMResponse([
        {
          type: 'action',
          title: 'Mixed actors',
          description: 'Some empty actors.',
          startTurnIndex: 0,
          endTurnIndex: 0,
          actors: ['user', '', '  ', 123],
        },
      ]);

      const result = parseEpisodeResponse(json, 3);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(1);
      expect(result.episodes[0].actors).toEqual(['user']);
    });

    it('should sort episodes by startTurnIndex', () => {
      const json = makeLLMResponse([
        { type: 'action', title: 'Third', description: 'Third episode', startTurnIndex: 4, endTurnIndex: 5, actors: ['user'] },
        { type: 'action', title: 'First', description: 'First episode', startTurnIndex: 0, endTurnIndex: 1, actors: ['user'] },
        { type: 'action', title: 'Second', description: 'Second episode', startTurnIndex: 2, endTurnIndex: 3, actors: ['user'] },
      ]);

      const result = parseEpisodeResponse(json, 5);
      expect(result.ok).toBe(true);
      expect(result.episodes.map(e => e.title)).toEqual(['First', 'Second', 'Third']);
    });

    it('should trim whitespace from title and description', () => {
      const json = makeLLMResponse([
        {
          type: 'action',
          title: '  Trimmed Title  ',
          description: '  Trimmed description.  ',
          startTurnIndex: 0,
          endTurnIndex: 0,
          actors: ['user'],
        },
      ]);

      const result = parseEpisodeResponse(json, 3);
      expect(result.episodes[0].title).toBe('Trimmed Title');
      expect(result.episodes[0].description).toBe('Trimmed description.');
    });

    it('should omit outcome when empty', () => {
      const json = makeLLMResponse([
        {
          type: 'action',
          title: 'No outcome',
          description: 'Episode without outcome.',
          startTurnIndex: 0,
          endTurnIndex: 0,
          actors: ['user'],
          outcome: '',
        },
      ]);

      const result = parseEpisodeResponse(json, 3);
      expect(result.episodes[0].outcome).toBeUndefined();
    });

    it('should return error for invalid JSON', () => {
      const result = parseEpisodeResponse('not json at all', 3);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Failed to parse/);
    });

    it('should return error for non-array JSON', () => {
      const result = parseEpisodeResponse('{"not": "an array"}', 3);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not an array/);
    });

    it('should handle all four episode types', () => {
      const json = makeLLMResponse([
        { type: 'action', title: 'A', description: 'D', startTurnIndex: 0, endTurnIndex: 0, actors: ['user'] },
        { type: 'decision', title: 'B', description: 'D', startTurnIndex: 1, endTurnIndex: 1, actors: ['user'] },
        { type: 'event', title: 'C', description: 'D', startTurnIndex: 2, endTurnIndex: 2, actors: ['user'] },
        { type: 'discovery', title: 'D', description: 'D', startTurnIndex: 3, endTurnIndex: 3, actors: ['user'] },
      ]);

      const result = parseEpisodeResponse(json, 3);
      expect(result.ok).toBe(true);
      expect(result.episodes.map(e => e.type)).toEqual(['action', 'decision', 'event', 'discovery']);
    });

    it('should handle overlapping turn ranges', () => {
      const json = makeLLMResponse([
        { type: 'action', title: 'A', description: 'D', startTurnIndex: 0, endTurnIndex: 2, actors: ['user'] },
        { type: 'decision', title: 'B', description: 'D', startTurnIndex: 1, endTurnIndex: 3, actors: ['user'] },
      ]);

      const result = parseEpisodeResponse(json, 3);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(2);
    });
  });

  describe('buildEpisodeExtractionRequest', () => {
    it('should build a request with conversation messages', () => {
      const messages: RawMessage[] = [
        { conversationId: 'c1', role: 'user', content: 'Help me write a function', turnIndex: 0, createdAt: '' },
        { conversationId: 'c1', role: 'assistant', content: 'Sure, here it is', turnIndex: 1, createdAt: '' },
      ];

      const request = buildEpisodeExtractionRequest(messages);
      expect(request.system).toContain('episode');
      expect(request.prompt).toContain('[Turn 0] user: Help me write a function');
      expect(request.prompt).toContain('[Turn 1] assistant: Sure, here it is');
      expect(request.responseFormat).toBe('json');
      expect(request.temperature).toBe(0);
    });

    it('should include maxEpisodes in prompt when specified', () => {
      const messages: RawMessage[] = [
        { conversationId: 'c1', role: 'user', content: 'Hello', turnIndex: 0, createdAt: '' },
      ];

      const request = buildEpisodeExtractionRequest(messages, 5);
      expect(request.prompt).toContain('at most 5 episodes');
    });
  });

  describe('EpisodeExtractor.extract', () => {
    it('should extract episodes from a conversation via LLM', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'Can you help me set up a TypeScript project?' },
        { role: 'assistant', content: 'Sure! Let me create the tsconfig.json for you.' },
        { role: 'user', content: 'Now let\'s add vitest for testing.' },
        { role: 'assistant', content: 'I\'ve configured vitest with the following settings...' },
      ]);

      llm.addResponse(makeLLMResponse([
        {
          type: 'action',
          title: 'Set up TypeScript project',
          description: 'The assistant created a tsconfig.json for the TypeScript project setup.',
          startTurnIndex: 0,
          endTurnIndex: 1,
          actors: ['user', 'assistant'],
          outcome: 'TypeScript project configured',
        },
        {
          type: 'action',
          title: 'Configure vitest',
          description: 'Added vitest testing framework configuration to the project.',
          startTurnIndex: 2,
          endTurnIndex: 3,
          actors: ['user', 'assistant'],
          outcome: 'Vitest configured',
        },
      ]));

      const result = await extractor.extract(conversation);

      expect(result.ok).toBe(true);
      expect(result.conversationId).toBe('conv-1');
      expect(result.episodes).toHaveLength(2);
      expect(result.extractionTimeMs).toBeGreaterThanOrEqual(0);

      // Check first episode
      const ep1 = result.episodes[0];
      expect(ep1.type).toBe('action');
      expect(ep1.title).toBe('Set up TypeScript project');
      expect(ep1.description).toBe('The assistant created a tsconfig.json for the TypeScript project setup.');
      expect(ep1.startTurnIndex).toBe(0);
      expect(ep1.endTurnIndex).toBe(1);
      expect(ep1.actors).toEqual(['user', 'assistant']);
      expect(ep1.conversationId).toBe('conv-1');
      expect(ep1.id).toBeDefined();
      expect(ep1.createdAt).toBeDefined();

      // Check source traceability and metadata
      expect(ep1.sourceMessageIds).toEqual(['conv-1:0', 'conv-1:1']);
      expect(ep1.outcome).toBe('TypeScript project configured');
      expect(ep1.metadata?.extractionModel).toBe('mock');

      // Check second episode
      const ep2 = result.episodes[1];
      expect(ep2.title).toBe('Configure vitest');
      expect(ep2.startTurnIndex).toBe(2);
      expect(ep2.endTurnIndex).toBe(3);
      expect(ep2.sourceMessageIds).toEqual(['conv-1:2', 'conv-1:3']);
    });

    it('should return empty episodes for empty conversation', async () => {
      const conversation = makeConversation([]);
      const result = await extractor.extract(conversation);

      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(0);
    });

    it('should handle LLM returning empty array', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ]);

      llm.addResponse('[]');
      const result = await extractor.extract(conversation);

      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(0);
    });

    it('should handle LLM returning invalid JSON gracefully', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ]);

      llm.addResponse('This is not JSON at all');
      const result = await extractor.extract(conversation);

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.rawResponse).toBe('This is not JSON at all');
      expect(result.episodes).toHaveLength(0);
    });

    it('should handle LLM throwing an error gracefully', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ]);

      // Override the mock to throw
      llm.addResponse(''); // won't be used
      const originalComplete = llm.complete.bind(llm);
      llm.complete = async () => { throw new Error('API rate limit exceeded'); };

      const result = await extractor.extract(conversation);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('API rate limit exceeded');
      expect(result.episodes).toHaveLength(0);

      llm.complete = originalComplete;
    });

    it('should generate unique IDs for each episode', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'Do thing A' },
        { role: 'assistant', content: 'Done A' },
        { role: 'user', content: 'Do thing B' },
        { role: 'assistant', content: 'Done B' },
      ]);

      llm.addResponse(makeLLMResponse([
        { type: 'action', title: 'A', description: 'Did A', startTurnIndex: 0, endTurnIndex: 1, actors: ['user'] },
        { type: 'action', title: 'B', description: 'Did B', startTurnIndex: 2, endTurnIndex: 3, actors: ['user'] },
      ]));

      const result = await extractor.extract(conversation);
      expect(result.episodes[0].id).not.toBe(result.episodes[1].id);
    });

    it('should respect maxEpisodes option', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'Step 1' },
        { role: 'assistant', content: 'Done 1' },
        { role: 'user', content: 'Step 2' },
        { role: 'assistant', content: 'Done 2' },
        { role: 'user', content: 'Step 3' },
        { role: 'assistant', content: 'Done 3' },
      ]);

      // LLM returns 3 episodes but maxEpisodes is 2
      llm.addResponse(makeLLMResponse([
        { type: 'action', title: 'A', description: 'D', startTurnIndex: 0, endTurnIndex: 1, actors: ['user'] },
        { type: 'action', title: 'B', description: 'D', startTurnIndex: 2, endTurnIndex: 3, actors: ['user'] },
        { type: 'action', title: 'C', description: 'D', startTurnIndex: 4, endTurnIndex: 5, actors: ['user'] },
      ]));

      const limitedExtractor = new EpisodeExtractor(llm, { maxEpisodes: 2 });
      const result = await limitedExtractor.extract(conversation);

      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(2);
    });

    it('should map source message IDs correctly for turn ranges', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
        { role: 'user', content: 'C' },
        { role: 'assistant', content: 'D' },
      ]);

      llm.addResponse(makeLLMResponse([
        {
          type: 'action',
          title: 'Full span',
          description: 'Spans all turns.',
          startTurnIndex: 0,
          endTurnIndex: 3,
          actors: ['user', 'assistant'],
        },
      ]));

      const result = await extractor.extract(conversation);
      const ep = result.episodes[0];
      expect(ep.sourceMessageIds).toEqual(['conv-1:0', 'conv-1:1', 'conv-1:2', 'conv-1:3']);
    });

    it('should send the correct prompt to the LLM', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'What is TypeScript?' },
        { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.' },
      ]);

      llm.addResponse('[]');
      await extractor.extract(conversation);

      expect(llm.calls).toHaveLength(1);
      const call = llm.calls[0];
      expect(call.system).toContain('episode');
      expect(call.system).toContain('action');
      expect(call.system).toContain('decision');
      expect(call.system).toContain('event');
      expect(call.system).toContain('discovery');
      expect(call.prompt).toContain('[Turn 0] user: What is TypeScript?');
      expect(call.prompt).toContain('[Turn 1] assistant: TypeScript is a typed superset of JavaScript.');
      expect(call.temperature).toBe(0);
      expect(call.responseFormat).toBe('json');
    });

    it('should handle single-turn episodes', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'The build just failed' },
        { role: 'assistant', content: 'Let me check the logs' },
      ]);

      llm.addResponse(makeLLMResponse([
        {
          type: 'event',
          title: 'Build failure',
          description: 'The user reported a build failure.',
          startTurnIndex: 0,
          endTurnIndex: 0,
          actors: ['user'],
        },
      ]));

      const result = await extractor.extract(conversation);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(1);
      expect(result.episodes[0].startTurnIndex).toBe(0);
      expect(result.episodes[0].endTurnIndex).toBe(0);
    });

    it('should handle discovery episode type', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'Why is the test failing?' },
        { role: 'assistant', content: 'I found the issue - there\'s a race condition in the async handler.' },
      ]);

      llm.addResponse(makeLLMResponse([
        {
          type: 'discovery',
          title: 'Identified race condition',
          description: 'Found a race condition in the async handler causing test failures.',
          startTurnIndex: 0,
          endTurnIndex: 1,
          actors: ['assistant'],
          outcome: 'Root cause identified',
        },
      ]));

      const result = await extractor.extract(conversation);
      expect(result.ok).toBe(true);
      expect(result.episodes[0].type).toBe('discovery');
      expect(result.episodes[0].outcome).toBe('Root cause identified');
    });

    it('should handle decision episode type', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'Should we use React or Vue?' },
        { role: 'assistant', content: 'Given your requirements, React with Next.js would be the best choice.' },
        { role: 'user', content: 'Agreed, let\'s go with React.' },
      ]);

      llm.addResponse(makeLLMResponse([
        {
          type: 'decision',
          title: 'Chose React over Vue',
          description: 'After discussing requirements, decided to use React with Next.js.',
          startTurnIndex: 0,
          endTurnIndex: 2,
          actors: ['user', 'assistant'],
          outcome: 'React with Next.js selected',
        },
      ]));

      const result = await extractor.extract(conversation);
      expect(result.ok).toBe(true);
      expect(result.episodes[0].type).toBe('decision');
      expect(result.episodes[0].actors).toEqual(['user', 'assistant']);
    });

    it('should preserve the episode type from LLM output', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ]);

      llm.addResponse(makeLLMResponse([
        { type: 'action', title: 'Greeting', description: 'Greeted', startTurnIndex: 0, endTurnIndex: 1, actors: ['user'] },
      ]));

      const result = await extractor.extract(conversation);
      expect(result.episodes[0].type).toBe('action');
    });

    it('should handle conversation with system message', async () => {
      const conversation = makeConversation([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Help me debug this code' },
        { role: 'assistant', content: 'I see the issue in line 42.' },
      ]);

      llm.addResponse(makeLLMResponse([
        {
          type: 'action',
          title: 'Debug code',
          description: 'Assisted with debugging code.',
          startTurnIndex: 1,
          endTurnIndex: 2,
          actors: ['user', 'assistant'],
        },
      ]));

      const result = await extractor.extract(conversation);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(1);
    });

    it('should include extractionModel in metadata', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'Test' },
        { role: 'assistant', content: 'Response' },
      ]);

      llm.addResponse(makeLLMResponse([
        { type: 'action', title: 'T', description: 'D', startTurnIndex: 0, endTurnIndex: 1, actors: ['user'] },
      ]));

      const result = await extractor.extract(conversation);
      expect(result.episodes[0].metadata?.extractionModel).toBe('mock');
    });
  });

  describe('Edge cases', () => {
    it('should handle very long conversations', async () => {
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (let i = 0; i < 100; i++) {
        messages.push({ role: 'user', content: `Question ${i}` });
        messages.push({ role: 'assistant', content: `Answer ${i}` });
      }
      const conversation = makeConversation(messages);

      llm.addResponse(makeLLMResponse([
        { type: 'action', title: 'Long conversation', description: 'Many turns.', startTurnIndex: 0, endTurnIndex: 199, actors: ['user', 'assistant'] },
      ]));

      const result = await extractor.extract(conversation);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(1);
      expect(result.episodes[0].sourceMessageIds).toHaveLength(200);
    });

    it('should handle LLM response with extra fields gracefully', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ]);

      llm.addResponse(JSON.stringify([
        {
          type: 'action',
          title: 'Greeting',
          description: 'Said hello.',
          startTurnIndex: 0,
          endTurnIndex: 1,
          actors: ['user'],
          extraField: 'should be ignored',
          another: 123,
        },
      ]));

      const result = await extractor.extract(conversation);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(1);
    });

    it('should handle null items in the LLM response array', async () => {
      const conversation = makeConversation([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ]);

      llm.addResponse(JSON.stringify([
        null,
        { type: 'action', title: 'Valid', description: 'OK', startTurnIndex: 0, endTurnIndex: 1, actors: ['user'] },
        42,
        'string',
      ]));

      const result = await extractor.extract(conversation);
      expect(result.ok).toBe(true);
      expect(result.episodes).toHaveLength(1);
    });
  });
});
