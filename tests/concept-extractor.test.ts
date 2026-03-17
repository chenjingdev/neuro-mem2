/**
 * Tests for Concept Extractor — validates LLM-based concept extraction
 * from conversations (batch, post-conversation processing).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConceptExtractor } from '../src/extraction/concept-extractor.js';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import {
  buildConceptExtractionRequest,
  getConceptExtractionSystemPrompt,
  type ConceptExtractionInput,
} from '../src/extraction/concept-prompt.js';

function makeInput(overrides: Partial<ConceptExtractionInput> = {}): ConceptExtractionInput {
  return {
    conversationId: 'conv-001',
    messages: [
      { role: 'user', content: 'I want to build a REST API using TypeScript and Express.' },
      { role: 'assistant', content: 'Great choice! TypeScript with Express is a solid stack for REST APIs. Should we use PostgreSQL for the database?' },
      { role: 'user', content: 'Yes, let\'s use PostgreSQL with Prisma as the ORM.' },
      { role: 'assistant', content: 'Perfect. Prisma works well with PostgreSQL and TypeScript. I\'ll set up the project with ESM modules.' },
    ],
    ...overrides,
  };
}

function makeLLMResponse(concepts: any[]): string {
  return JSON.stringify({ concepts });
}

describe('ConceptExtractor', () => {
  let provider: MockLLMProvider;
  let extractor: ConceptExtractor;

  beforeEach(() => {
    provider = new MockLLMProvider();
    extractor = new ConceptExtractor(provider);
  });

  describe('extract', () => {
    it('should extract concepts from a conversation', async () => {
      provider.addResponse(makeLLMResponse([
        {
          name: 'TypeScript',
          description: 'Statically typed JavaScript superset used as the primary language',
          aliases: ['TS'],
          category: 'technology',
          relevance: 0.95,
          relatedConcepts: ['Express', 'Node.js'],
        },
        {
          name: 'Express',
          description: 'Node.js web framework for building REST APIs',
          aliases: ['Express.js'],
          category: 'technology',
          relevance: 0.9,
          relatedConcepts: ['TypeScript', 'REST API'],
        },
        {
          name: 'PostgreSQL',
          description: 'Relational database chosen for the project',
          aliases: ['Postgres', 'PG'],
          category: 'technology',
          relevance: 0.85,
          relatedConcepts: ['Prisma'],
        },
      ]));

      const result = await extractor.extract(makeInput());

      expect(result.conversationId).toBe('conv-001');
      expect(result.concepts).toHaveLength(3);
      expect(result.concepts[0].type).toBe('concept');
      expect(result.concepts[0].name).toBe('TypeScript');
      expect(result.concepts[0].content).toBe('Statically typed JavaScript superset used as the primary language');
      expect(result.concepts[0].aliases).toEqual(['TS']);
      expect(result.concepts[0].category).toBe('technology');
      expect(result.concepts[0].id).toBeTruthy();
      expect(result.concepts[0].createdAt).toBeTruthy();
      expect(result.extractedAt).toBeTruthy();
    });

    it('should create concept_related_to edges between extracted concepts', async () => {
      provider.addResponse(makeLLMResponse([
        {
          name: 'TypeScript',
          description: 'Primary language',
          aliases: [],
          category: 'technology',
          relevance: 0.95,
          relatedConcepts: ['Express'],
        },
        {
          name: 'Express',
          description: 'Web framework',
          aliases: [],
          category: 'technology',
          relevance: 0.9,
          relatedConcepts: ['TypeScript'],
        },
      ]));

      const result = await extractor.extract(makeInput());

      expect(result.edges.length).toBeGreaterThanOrEqual(1);
      const edge = result.edges[0];
      expect(edge.edgeType).toBe('concept_related_to');
      expect(edge.weight).toBeGreaterThan(0);
      expect(edge.weight).toBeLessThanOrEqual(1);
      // Verify the edge connects the two concepts
      const conceptIds = result.concepts.map((c) => c.id);
      expect(conceptIds).toContain(edge.sourceId);
      expect(conceptIds).toContain(edge.targetId);
    });

    it('should not create duplicate edges (A→B and B→A)', async () => {
      provider.addResponse(makeLLMResponse([
        {
          name: 'A',
          description: 'Concept A',
          aliases: [],
          category: 'technology',
          relevance: 0.9,
          relatedConcepts: ['B'],
        },
        {
          name: 'B',
          description: 'Concept B',
          aliases: [],
          category: 'technology',
          relevance: 0.8,
          relatedConcepts: ['A'],
        },
      ]));

      const result = await extractor.extract(makeInput());

      // Should have exactly 1 edge, not 2
      expect(result.edges).toHaveLength(1);
    });

    it('should return empty result for empty messages', async () => {
      const result = await extractor.extract(makeInput({ messages: [] }));

      expect(result.concepts).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
      expect(provider.calls).toHaveLength(0); // No LLM call made
    });

    it('should filter concepts below minimum relevance', async () => {
      const strictExtractor = new ConceptExtractor(provider, { minRelevance: 0.7 });

      provider.addResponse(makeLLMResponse([
        {
          name: 'TypeScript',
          description: 'Primary language',
          aliases: [],
          category: 'technology',
          relevance: 0.95,
          relatedConcepts: [],
        },
        {
          name: 'ESM',
          description: 'Module system mentioned briefly',
          aliases: [],
          category: 'technology',
          relevance: 0.3, // Below threshold
          relatedConcepts: [],
        },
      ]));

      const result = await strictExtractor.extract(makeInput());

      expect(result.concepts).toHaveLength(1);
      expect(result.concepts[0].name).toBe('TypeScript');
    });

    it('should limit number of concepts to maxConcepts', async () => {
      const limitedExtractor = new ConceptExtractor(provider, { maxConcepts: 2 });

      provider.addResponse(makeLLMResponse([
        { name: 'A', description: 'a', aliases: [], category: 'technology', relevance: 0.9, relatedConcepts: [] },
        { name: 'B', description: 'b', aliases: [], category: 'technology', relevance: 0.8, relatedConcepts: [] },
        { name: 'C', description: 'c', aliases: [], category: 'technology', relevance: 0.7, relatedConcepts: [] },
        { name: 'D', description: 'd', aliases: [], category: 'technology', relevance: 0.6, relatedConcepts: [] },
      ]));

      const result = await limitedExtractor.extract(makeInput());

      expect(result.concepts).toHaveLength(2);
      // Should keep the top 2 by relevance
      expect(result.concepts[0].name).toBe('A');
      expect(result.concepts[1].name).toBe('B');
    });

    it('should store relevance in metadata', async () => {
      provider.addResponse(makeLLMResponse([
        {
          name: 'TypeScript',
          description: 'Primary language',
          aliases: [],
          category: 'technology',
          relevance: 0.95,
          relatedConcepts: [],
        },
      ]));

      const result = await extractor.extract(makeInput());

      expect(result.concepts[0].metadata).toEqual({
        relevance: 0.95,
        relatedConcepts: [],
      });
    });

    it('should handle LLM error gracefully', async () => {
      const failingProvider: MockLLMProvider = new MockLLMProvider();
      // Override complete to throw
      failingProvider.complete = async () => {
        throw new Error('LLM API timeout');
      };

      const failExtractor = new ConceptExtractor(failingProvider);

      await expect(failExtractor.extract(makeInput())).rejects.toThrow('LLM API timeout');
    });
  });

  describe('JSON parsing resilience', () => {
    it('should handle response wrapped in markdown code fences', async () => {
      provider.addResponse('```json\n' + makeLLMResponse([
        {
          name: 'TypeScript',
          description: 'Language',
          aliases: [],
          category: 'technology',
          relevance: 0.9,
          relatedConcepts: [],
        },
      ]) + '\n```');

      const result = await extractor.extract(makeInput());

      expect(result.concepts).toHaveLength(1);
      expect(result.concepts[0].name).toBe('TypeScript');
    });

    it('should return empty for invalid JSON', async () => {
      provider.addResponse('This is not JSON at all');

      const result = await extractor.extract(makeInput());

      expect(result.concepts).toHaveLength(0);
    });

    it('should return empty for JSON without concepts array', async () => {
      provider.addResponse('{"data": []}');

      const result = await extractor.extract(makeInput());

      expect(result.concepts).toHaveLength(0);
    });

    it('should skip invalid concept entries', async () => {
      provider.addResponse(JSON.stringify({
        concepts: [
          { name: 'Valid', description: 'ok', aliases: [], category: 'technology', relevance: 0.9, relatedConcepts: [] },
          { description: 'missing name', aliases: [], category: 'technology', relevance: 0.9, relatedConcepts: [] },
          { name: '', description: 'empty name', aliases: [], category: 'technology', relevance: 0.9, relatedConcepts: [] },
          null,
          42,
          { name: 'NoRelevance', description: 'missing relevance' },
        ],
      }));

      const result = await extractor.extract(makeInput());

      // Only the first entry is valid (NoRelevance has no relevance number)
      expect(result.concepts).toHaveLength(1);
      expect(result.concepts[0].name).toBe('Valid');
    });

    it('should normalize unknown categories to other', async () => {
      provider.addResponse(makeLLMResponse([
        {
          name: 'Something',
          description: 'Unknown category',
          aliases: [],
          category: 'unknown_category',
          relevance: 0.8,
          relatedConcepts: [],
        },
      ]));

      const result = await extractor.extract(makeInput());

      expect(result.concepts[0].category).toBe('other');
    });

    it('should clamp relevance to [0, 1]', async () => {
      // Use minRelevance: 0 to not filter out the clamped-to-zero concept
      const lenientExtractor = new ConceptExtractor(provider, { minRelevance: 0 });

      provider.addResponse(makeLLMResponse([
        {
          name: 'HighRelevance',
          description: 'Too high',
          aliases: [],
          category: 'technology',
          relevance: 1.5,
          relatedConcepts: [],
        },
        {
          name: 'NegRelevance',
          description: 'Negative',
          aliases: [],
          category: 'technology',
          relevance: -0.3,
          relatedConcepts: [],
        },
      ]));

      const result = await lenientExtractor.extract(makeInput());

      expect(result.concepts).toHaveLength(2);
      const relevances = result.concepts.map((c) => (c.metadata as any)?.relevance);
      expect(relevances[0]).toBe(1);
      expect(relevances[1]).toBe(0);
    });
  });

  describe('deduplication', () => {
    it('should deduplicate concepts with same name (case-insensitive)', async () => {
      provider.addResponse(makeLLMResponse([
        {
          name: 'TypeScript',
          description: 'Language 1',
          aliases: [],
          category: 'technology',
          relevance: 0.8,
          relatedConcepts: [],
        },
        {
          name: 'typescript',
          description: 'Language 2',
          aliases: [],
          category: 'technology',
          relevance: 0.9,
          relatedConcepts: [],
        },
      ]));

      const result = await extractor.extract(makeInput());

      expect(result.concepts).toHaveLength(1);
      // Should keep the one with higher relevance
      expect(result.concepts[0].name).toBe('typescript');
      expect((result.concepts[0].metadata as any)?.relevance).toBe(0.9);
    });

    it('should deduplicate concepts matching by alias', async () => {
      provider.addResponse(makeLLMResponse([
        {
          name: 'TypeScript',
          description: 'Language',
          aliases: ['TS'],
          category: 'technology',
          relevance: 0.9,
          relatedConcepts: [],
        },
        {
          name: 'TS',
          description: 'TypeScript alias',
          aliases: [],
          category: 'technology',
          relevance: 0.7,
          relatedConcepts: [],
        },
      ]));

      const result = await extractor.extract(makeInput());

      expect(result.concepts).toHaveLength(1);
      expect(result.concepts[0].name).toBe('TypeScript');
    });

    it('should exclude concepts that match existing concepts', async () => {
      provider.addResponse(makeLLMResponse([
        {
          name: 'TypeScript',
          description: 'Already known',
          aliases: [],
          category: 'technology',
          relevance: 0.9,
          relatedConcepts: [],
        },
        {
          name: 'Prisma',
          description: 'New concept',
          aliases: [],
          category: 'technology',
          relevance: 0.8,
          relatedConcepts: [],
        },
      ]));

      const result = await extractor.extract(makeInput({
        existingConcepts: [
          { name: 'TypeScript', aliases: ['TS'], category: 'technology' },
        ],
      }));

      expect(result.concepts).toHaveLength(1);
      expect(result.concepts[0].name).toBe('Prisma');
    });

    it('should exclude concepts matching existing concept aliases', async () => {
      provider.addResponse(makeLLMResponse([
        {
          name: 'PG',
          description: 'PostgreSQL by alias',
          aliases: [],
          category: 'technology',
          relevance: 0.9,
          relatedConcepts: [],
        },
      ]));

      const result = await extractor.extract(makeInput({
        existingConcepts: [
          { name: 'PostgreSQL', aliases: ['Postgres', 'PG'], category: 'technology' },
        ],
      }));

      expect(result.concepts).toHaveLength(0);
    });

    it('should merge aliases when deduplicating', async () => {
      provider.addResponse(makeLLMResponse([
        {
          name: 'PostgreSQL',
          description: 'Database',
          aliases: ['Postgres'],
          category: 'technology',
          relevance: 0.9,
          relatedConcepts: [],
        },
        {
          name: 'PG',
          description: 'PostgreSQL shorthand',
          aliases: ['PostgreSQL'],
          category: 'technology',
          relevance: 0.7,
          relatedConcepts: [],
        },
      ]));

      const result = await extractor.extract(makeInput());

      expect(result.concepts).toHaveLength(1);
      // Should keep PostgreSQL (higher relevance) and merge aliases
      expect(result.concepts[0].name).toBe('PostgreSQL');
      const aliases = result.concepts[0].aliases ?? [];
      expect(aliases).toContain('Postgres');
      // PG should be in aliases since it was the name of the merged concept
      expect(aliases.some((a) => a.toLowerCase() === 'pg')).toBe(true);
    });
  });

  describe('edge weight calculation', () => {
    it('should calculate edge weight as average of related concept relevances', async () => {
      provider.addResponse(makeLLMResponse([
        {
          name: 'TypeScript',
          description: 'Primary language',
          aliases: [],
          category: 'technology',
          relevance: 1.0,
          relatedConcepts: ['Express'],
        },
        {
          name: 'Express',
          description: 'Web framework',
          aliases: [],
          category: 'technology',
          relevance: 0.8,
          relatedConcepts: [],
        },
      ]));

      const result = await extractor.extract(makeInput());

      expect(result.edges).toHaveLength(1);
      // (1.0 + 0.8) / 2 = 0.9
      expect(result.edges[0].weight).toBe(0.9);
    });

    it('should not create edges to concepts not in the extracted set', async () => {
      provider.addResponse(makeLLMResponse([
        {
          name: 'TypeScript',
          description: 'Primary language',
          aliases: [],
          category: 'technology',
          relevance: 0.95,
          relatedConcepts: ['NonExistentConcept'],
        },
      ]));

      const result = await extractor.extract(makeInput());

      expect(result.edges).toHaveLength(0);
    });
  });
});

describe('buildConceptExtractionRequest', () => {
  it('should build a valid LLM request', () => {
    const input = makeInput();
    const request = buildConceptExtractionRequest(input);

    expect(request.system).toBeTruthy();
    expect(request.prompt).toContain('REST API');
    expect(request.prompt).toContain('TypeScript');
    expect(request.responseFormat).toBe('json');
    expect(request.temperature).toBe(0.2);
    expect(request.maxTokens).toBe(4096);
  });

  it('should include existing facts in the prompt', () => {
    const input = makeInput({
      existingFacts: [
        { content: 'User prefers TypeScript', category: 'preference', entities: ['TypeScript'] },
      ],
    });

    const request = buildConceptExtractionRequest(input);

    expect(request.prompt).toContain('extracted_facts');
    expect(request.prompt).toContain('User prefers TypeScript');
  });

  it('should include existing concepts for deduplication', () => {
    const input = makeInput({
      existingConcepts: [
        { name: 'TypeScript', aliases: ['TS'], category: 'technology' },
      ],
    });

    const request = buildConceptExtractionRequest(input);

    expect(request.prompt).toContain('existing_concepts');
    expect(request.prompt).toContain('TypeScript');
    expect(request.prompt).toContain('TS');
  });

  it('should format conversation messages in order', () => {
    const input = makeInput();
    const request = buildConceptExtractionRequest(input);

    expect(request.prompt).toContain('<user>');
    expect(request.prompt).toContain('</user>');
    expect(request.prompt).toContain('<assistant>');
    expect(request.prompt).toContain('</assistant>');

    // User message should come before assistant
    const userIdx = request.prompt.indexOf('<user>');
    const assistantIdx = request.prompt.indexOf('<assistant>');
    expect(userIdx).toBeLessThan(assistantIdx);
  });
});

describe('getConceptExtractionSystemPrompt', () => {
  it('should return a non-empty system prompt', () => {
    const prompt = getConceptExtractionSystemPrompt();
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toContain('concept');
    expect(prompt).toContain('technology');
  });
});
