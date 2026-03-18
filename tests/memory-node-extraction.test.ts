/**
 * Tests for unified MemoryNode extraction — verifying that LLM extracts
 * searchKeywords and relatedEntities together with each memory node.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import { MemoryNodeExtractor } from '../src/extraction/memory-node-extractor.js';
import {
  parseMemoryNodeResponse,
  type MemoryNodeParseResult,
} from '../src/extraction/memory-node-parser.js';
import {
  buildMemoryNodeExtractionRequest,
  getMemoryNodeExtractionSystemPrompt,
  type MemoryNodeExtractionInput,
} from '../src/extraction/memory-node-prompt.js';

// ─── Fixtures ────────────────────────────────────────────────────

const BASIC_INPUT: MemoryNodeExtractionInput = {
  conversationId: 'conv-001',
  userMessage: {
    content: '나는 TypeScript를 백엔드 개발에 선호해. React 프로젝트에서 사용하고 있어.',
    turnIndex: 0,
  },
  assistantMessage: {
    content: 'TypeScript를 백엔드에 사용하시는 군요! 타입 안전성이 큰 장점이죠.',
    turnIndex: 1,
  },
};

const MULTI_TYPE_RESPONSE = JSON.stringify({
  nodes: [
    {
      nodeType: 'semantic',
      frontmatter: 'User prefers TypeScript for backend',
      summary: 'The user prefers TypeScript over JavaScript for backend development.',
      searchKeywords: ['TypeScript', '타입스크립트', 'backend', '백엔드', 'language preference', '언어 선호'],
      relatedEntities: ['TypeScript', 'JavaScript', 'React'],
      metadata: {
        category: 'preference',
        confidence: 0.95,
        subject: 'user',
        predicate: 'prefers',
        object: 'TypeScript',
      },
    },
    {
      nodeType: 'episodic',
      frontmatter: 'Using React with TypeScript',
      summary: 'User is currently working on a React project using TypeScript.',
      searchKeywords: ['React', '리액트', 'TypeScript', 'project', '프로젝트'],
      relatedEntities: ['React', 'TypeScript'],
      metadata: {
        episodeType: 'event',
        actors: ['user'],
        outcome: 'ongoing development',
      },
    },
  ],
});

const EMPTY_RESPONSE = JSON.stringify({ nodes: [] });

const KOREAN_HEAVY_RESPONSE = JSON.stringify({
  nodes: [
    {
      nodeType: 'semantic',
      frontmatter: '사용자는 PostgreSQL을 선호함',
      summary: '사용자는 데이터베이스로 PostgreSQL을 MySQL보다 선호합니다.',
      searchKeywords: ['PostgreSQL', 'MySQL', '데이터베이스', 'database', 'DB 선호', '포스트그레스'],
      relatedEntities: ['PostgreSQL', 'MySQL'],
      metadata: {
        category: 'preference',
        confidence: 0.9,
        subject: '사용자',
        predicate: '선호',
        object: 'PostgreSQL',
      },
    },
  ],
});

// ─── Parser Tests ────────────────────────────────────────────────

describe('parseMemoryNodeResponse', () => {
  it('parses multi-node response with searchKeywords and relatedEntities', () => {
    const result = parseMemoryNodeResponse(MULTI_TYPE_RESPONSE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nodes).toHaveLength(2);

    // First node: semantic
    const semantic = result.nodes[0]!;
    expect(semantic.nodeType).toBe('semantic');
    expect(semantic.searchKeywords).toEqual([
      'TypeScript', '타입스크립트', 'backend', '백엔드', 'language preference', '언어 선호',
    ]);
    expect(semantic.relatedEntities).toEqual(['TypeScript', 'JavaScript', 'React']);
    expect(semantic.keywords).toBe('TypeScript 타입스크립트 backend 백엔드 language preference 언어 선호');
    expect(semantic.metadata.entities).toEqual(['TypeScript', 'JavaScript', 'React']);
    expect(semantic.metadata.subject).toBe('user');
    expect(semantic.metadata.predicate).toBe('prefers');
    expect(semantic.metadata.object).toBe('TypeScript');

    // Second node: episodic
    const episodic = result.nodes[1]!;
    expect(episodic.nodeType).toBe('episodic');
    expect(episodic.searchKeywords).toEqual(['React', '리액트', 'TypeScript', 'project', '프로젝트']);
    expect(episodic.relatedEntities).toEqual(['React', 'TypeScript']);
    expect(episodic.metadata.episodeType).toBe('event');
  });

  it('parses Korean-heavy bilingual response', () => {
    const result = parseMemoryNodeResponse(KOREAN_HEAVY_RESPONSE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0]!;
    expect(node.searchKeywords).toContain('데이터베이스');
    expect(node.searchKeywords).toContain('database');
    expect(node.searchKeywords).toContain('포스트그레스');
    expect(node.relatedEntities).toEqual(['PostgreSQL', 'MySQL']);
    expect(node.keywords).toContain('데이터베이스');
    expect(node.keywords).toContain('database');
  });

  it('parses empty response', () => {
    const result = parseMemoryNodeResponse(EMPTY_RESPONSE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes).toHaveLength(0);
  });

  it('handles whitespace-only input', () => {
    const result = parseMemoryNodeResponse('   ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes).toHaveLength(0);
  });

  it('handles markdown-fenced JSON', () => {
    const fenced = '```json\n' + MULTI_TYPE_RESPONSE + '\n```';
    const result = parseMemoryNodeResponse(fenced);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]!.searchKeywords.length).toBeGreaterThan(0);
  });

  it('handles bare array format', () => {
    const bareArray = JSON.stringify([
      {
        nodeType: 'semantic',
        frontmatter: 'Test node',
        summary: 'A test memory node.',
        searchKeywords: ['test', '테스트'],
        relatedEntities: ['TestEntity'],
        metadata: { category: 'other', confidence: 0.8 },
      },
    ]);
    const result = parseMemoryNodeResponse(bareArray);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.searchKeywords).toEqual(['test', '테스트']);
  });

  it('defaults missing searchKeywords to empty array', () => {
    const noKeywords = JSON.stringify({
      nodes: [{
        nodeType: 'semantic',
        frontmatter: 'No keywords node',
        summary: 'A node without keywords.',
        metadata: { category: 'other' },
      }],
    });
    const result = parseMemoryNodeResponse(noKeywords);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes[0]!.searchKeywords).toEqual([]);
    expect(result.nodes[0]!.keywords).toBe('');
  });

  it('defaults missing relatedEntities to empty array', () => {
    const noEntities = JSON.stringify({
      nodes: [{
        nodeType: 'episodic',
        frontmatter: 'No entities node',
        summary: 'A node without entities.',
        searchKeywords: ['keyword1'],
        metadata: { episodeType: 'event' },
      }],
    });
    const result = parseMemoryNodeResponse(noEntities);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes[0]!.relatedEntities).toEqual([]);
  });

  it('merges relatedEntities into metadata.entities without duplicates', () => {
    const withBoth = JSON.stringify({
      nodes: [{
        nodeType: 'semantic',
        frontmatter: 'Merged entities',
        summary: 'Test merging entities.',
        searchKeywords: ['test'],
        relatedEntities: ['EntityA', 'EntityB'],
        metadata: {
          category: 'technical',
          confidence: 0.9,
          entities: ['EntityA', 'EntityC'],
        },
      }],
    });
    const result = parseMemoryNodeResponse(withBoth);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entities = result.nodes[0]!.metadata.entities!;
    expect(entities).toContain('EntityA');
    expect(entities).toContain('EntityB');
    expect(entities).toContain('EntityC');
    // No duplicates
    expect(entities.filter((e: string) => e === 'EntityA')).toHaveLength(1);
  });

  it('filters out empty/whitespace-only keywords and entities', () => {
    const withEmpty = JSON.stringify({
      nodes: [{
        nodeType: 'semantic',
        frontmatter: 'Filter test',
        summary: 'Testing filter.',
        searchKeywords: ['valid', '', '  ', 'also valid'],
        relatedEntities: ['Entity', '', '  '],
        metadata: {},
      }],
    });
    const result = parseMemoryNodeResponse(withEmpty);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes[0]!.searchKeywords).toEqual(['valid', 'also valid']);
    expect(result.nodes[0]!.relatedEntities).toEqual(['Entity']);
  });

  it('handles invalid nodeType gracefully (defaults to semantic)', () => {
    const invalid = JSON.stringify({
      nodes: [{
        nodeType: 'invalid_type',
        frontmatter: 'Bad type',
        summary: 'Invalid nodeType test.',
        searchKeywords: ['test'],
        relatedEntities: [],
        metadata: {},
      }],
    });
    const result = parseMemoryNodeResponse(invalid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes[0]!.nodeType).toBe('semantic');
  });

  it('returns error for malformed JSON', () => {
    const result = parseMemoryNodeResponse('not json at all');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('JSON parse error');
  });

  it('skips nodes without frontmatter and summary', () => {
    const noContent = JSON.stringify({
      nodes: [
        { nodeType: 'semantic', frontmatter: '', summary: '', searchKeywords: ['a'], relatedEntities: [], metadata: {} },
        { nodeType: 'semantic', frontmatter: 'Valid node', summary: 'Has content', searchKeywords: ['b'], relatedEntities: [], metadata: {} },
      ],
    });
    const result = parseMemoryNodeResponse(noContent);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.frontmatter).toBe('Valid node');
  });

  it('handles all 5 nodeTypes with type-specific metadata', () => {
    const allTypes = JSON.stringify({
      nodes: [
        {
          nodeType: 'semantic',
          frontmatter: 'Semantic node',
          summary: 'A semantic fact.',
          searchKeywords: ['fact'],
          relatedEntities: ['Entity1'],
          metadata: { category: 'knowledge', confidence: 0.9, subject: 'S', predicate: 'P', object: 'O' },
        },
        {
          nodeType: 'episodic',
          frontmatter: 'Episodic node',
          summary: 'An event.',
          searchKeywords: ['event'],
          relatedEntities: ['Entity2'],
          metadata: { episodeType: 'action', actors: ['user'], outcome: 'done' },
        },
        {
          nodeType: 'procedural',
          frontmatter: 'Procedural node',
          summary: 'A how-to.',
          searchKeywords: ['how-to'],
          relatedEntities: ['Tool1'],
          metadata: { steps: ['step1', 'step2'], prerequisites: ['prereq1'] },
        },
        {
          nodeType: 'prospective',
          frontmatter: 'Prospective node',
          summary: 'A plan.',
          searchKeywords: ['plan'],
          relatedEntities: ['Project1'],
          metadata: { priority: 'high', status: 'pending', dueDate: '2026-04-01' },
        },
        {
          nodeType: 'emotional',
          frontmatter: 'Emotional node',
          summary: 'Frustration about builds.',
          searchKeywords: ['frustration', '좌절'],
          relatedEntities: [],
          metadata: { emotion: 'frustration', intensity: 0.7, trigger: 'slow builds' },
        },
      ],
    });

    const result = parseMemoryNodeResponse(allTypes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes).toHaveLength(5);

    expect(result.nodes[0]!.metadata.subject).toBe('S');
    expect(result.nodes[1]!.metadata.episodeType).toBe('action');
    expect(result.nodes[2]!.metadata.steps).toEqual(['step1', 'step2']);
    expect(result.nodes[3]!.metadata.priority).toBe('high');
    expect(result.nodes[4]!.metadata.emotion).toBe('frustration');
  });
});

// ─── Prompt Tests ────────────────────────────────────────────────

describe('buildMemoryNodeExtractionRequest', () => {
  it('includes searchKeywords instruction in system prompt', () => {
    const systemPrompt = getMemoryNodeExtractionSystemPrompt();
    expect(systemPrompt).toContain('searchKeywords');
    expect(systemPrompt).toContain('relatedEntities');
    expect(systemPrompt).toContain('한영 혼용');
  });

  it('builds valid LLM request with prior context', () => {
    const request = buildMemoryNodeExtractionRequest({
      ...BASIC_INPUT,
      priorContext: 'Previous conversation about databases...',
    });
    expect(request.system).toContain('searchKeywords');
    expect(request.system).toContain('relatedEntities');
    expect(request.prompt).toContain('<prior_context>');
    expect(request.prompt).toContain('Previous conversation about databases');
    expect(request.prompt).toContain('<user_message>');
    expect(request.prompt).toContain('<assistant_message>');
    expect(request.responseFormat).toBe('json');
    expect(request.temperature).toBe(0.1);
  });

  it('builds request without prior context', () => {
    const request = buildMemoryNodeExtractionRequest(BASIC_INPUT);
    expect(request.prompt).not.toContain('<prior_context>');
    expect(request.prompt).toContain('TypeScript');
  });
});

// ─── Extractor Integration Tests ─────────────────────────────────

describe('MemoryNodeExtractor', () => {
  let mockProvider: MockLLMProvider;
  let extractor: MemoryNodeExtractor;

  beforeEach(() => {
    mockProvider = new MockLLMProvider();
    extractor = new MemoryNodeExtractor(mockProvider);
  });

  it('extracts nodes with searchKeywords and relatedEntities in a single LLM call', async () => {
    mockProvider.addResponse(MULTI_TYPE_RESPONSE);

    const result = await extractor.extractFromTurn(BASIC_INPUT, 42.0);

    expect(result.ok).toBe(true);
    expect(result.nodes).toHaveLength(2);

    // Verify searchKeywords extracted
    expect(result.nodes[0]!.searchKeywords).toContain('TypeScript');
    expect(result.nodes[0]!.searchKeywords).toContain('타입스크립트');

    // Verify relatedEntities extracted
    expect(result.nodes[0]!.relatedEntities).toContain('TypeScript');
    expect(result.nodes[0]!.relatedEntities).toContain('React');

    // Verify only 1 LLM call was made (budget constraint)
    expect(mockProvider.calls).toHaveLength(1);
  });

  it('produces CreateMemoryNodeInput with keywords from searchKeywords', async () => {
    mockProvider.addResponse(MULTI_TYPE_RESPONSE);

    const result = await extractor.extractFromTurn(BASIC_INPUT, 42.0);

    expect(result.createInputs).toHaveLength(2);

    const first = result.createInputs[0]!;
    // keywords should be space-separated searchKeywords
    expect(first.keywords).toBe('TypeScript 타입스크립트 backend 백엔드 language preference 언어 선호');
    // metadata.entities should include relatedEntities
    expect(first.metadata!.entities).toContain('TypeScript');
    expect(first.metadata!.entities).toContain('React');
    // Source references
    expect(first.conversationId).toBe('conv-001');
    expect(first.sourceTurnIndex).toBe(0);
    expect(first.sourceMessageIds).toEqual(['conv-001:0', 'conv-001:1']);
    expect(first.currentEventCounter).toBe(42.0);
    expect(first.nodeRole).toBe('leaf');
    // extractionModel in metadata
    expect(first.metadata!.extractionModel).toBe('mock');
  });

  it('handles empty input gracefully', async () => {
    const emptyInput: MemoryNodeExtractionInput = {
      conversationId: 'conv-002',
      userMessage: { content: '', turnIndex: 0 },
      assistantMessage: { content: '', turnIndex: 1 },
    };

    const result = await extractor.extractFromTurn(emptyInput);
    expect(result.ok).toBe(true);
    expect(result.nodes).toHaveLength(0);
    expect(result.createInputs).toHaveLength(0);
    // No LLM call should have been made
    expect(mockProvider.calls).toHaveLength(0);
  });

  it('handles LLM returning empty nodes array', async () => {
    mockProvider.addResponse(EMPTY_RESPONSE);

    const result = await extractor.extractFromTurn(BASIC_INPUT);
    expect(result.ok).toBe(true);
    expect(result.nodes).toHaveLength(0);
    expect(result.createInputs).toHaveLength(0);
  });

  it('handles LLM error gracefully', async () => {
    // MockLLMProvider returns '{"facts": []}' by default when no response queued
    // Let's make it throw
    const failProvider: MockLLMProvider = new MockLLMProvider();
    const failExtractor = new MemoryNodeExtractor(failProvider);
    // Override complete to throw
    failProvider.complete = async () => { throw new Error('LLM timeout'); };

    const result = await failExtractor.extractFromTurn(BASIC_INPUT);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('LLM timeout');
  });

  it('handles malformed LLM response', async () => {
    mockProvider.addResponse('This is not valid JSON at all');

    const result = await extractor.extractFromTurn(BASIC_INPUT);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('JSON parse error');
    expect(result.rawResponse).toBe('This is not valid JSON at all');
  });

  it('processes multiple turns sequentially', async () => {
    mockProvider.addResponse(MULTI_TYPE_RESPONSE);
    mockProvider.addResponse(KOREAN_HEAVY_RESPONSE);

    const input2: MemoryNodeExtractionInput = {
      conversationId: 'conv-001',
      userMessage: { content: 'PostgreSQL이 좋아요', turnIndex: 2 },
      assistantMessage: { content: '좋은 선택이네요!', turnIndex: 3 },
    };

    const results = await extractor.extractFromTurns([BASIC_INPUT, input2], 50.0);

    expect(results).toHaveLength(2);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.nodes).toHaveLength(2);
    expect(results[1]!.ok).toBe(true);
    expect(results[1]!.nodes).toHaveLength(1);

    // Verify 2 LLM calls (1 per turn)
    expect(mockProvider.calls).toHaveLength(2);
  });

  it('preserves raw response for debugging', async () => {
    mockProvider.addResponse(MULTI_TYPE_RESPONSE);

    const result = await extractor.extractFromTurn(BASIC_INPUT);
    expect(result.rawResponse).toBe(MULTI_TYPE_RESPONSE);
  });

  it('includes relatedEntities from metadata.entities and relatedEntities without duplicates', async () => {
    const responseWithOverlap = JSON.stringify({
      nodes: [{
        nodeType: 'semantic',
        frontmatter: 'Overlap test',
        summary: 'Testing entity overlap.',
        searchKeywords: ['test'],
        relatedEntities: ['EntityA', 'EntityB'],
        metadata: {
          category: 'technical',
          confidence: 0.9,
          entities: ['EntityA', 'EntityC'],
        },
      }],
    });
    mockProvider.addResponse(responseWithOverlap);

    const result = await extractor.extractFromTurn(BASIC_INPUT);
    expect(result.ok).toBe(true);
    const entities = result.createInputs[0]!.metadata!.entities!;
    expect(entities).toContain('EntityA');
    expect(entities).toContain('EntityB');
    expect(entities).toContain('EntityC');
    // No duplicates
    const uniqueEntities = [...new Set(entities)];
    expect(entities.length).toBe(uniqueEntities.length);
  });
});
