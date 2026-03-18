/**
 * Tests for MemoryNodeExtractionPipeline — verifies:
 * 1. Single LLM call per turn extracts ALL 5 nodeTypes
 * 2. Pipeline integrates with EventBus, MemoryNodeExtractor, MemoryNodeRepository
 * 3. searchKeywords → L0 keywords + relatedEntities → L1 metadata.entities
 * 4. 1-call/turn budget constraint is respected
 * 5. Error handling and edge cases
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import { MemoryNodeExtractor } from '../src/extraction/memory-node-extractor.js';
import { MemoryNodeExtractionPipeline } from '../src/pipeline/memory-node-extraction-pipeline.js';
import { EventBus } from '../src/events/event-bus.js';
import type {
  TurnCompletedEvent,
  MemoryNodesExtractedEvent,
  ExtractionErrorEvent,
} from '../src/events/event-bus.js';
import type { MemoryNode, CreateMemoryNodeInput } from '../src/models/memory-node.js';

// ─── Mock ConversationRepository ────────────────────────────────

class MockConversationRepo {
  private messages: Array<{ conversationId: string; turnIndex: number; role: string; content: string }> = [];

  addMessages(msgs: Array<{ conversationId: string; turnIndex: number; role: string; content: string }>) {
    this.messages.push(...msgs);
  }

  getMessages(conversationId: string) {
    return this.messages
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.turnIndex - b.turnIndex);
  }
}

// ─── Mock MemoryNodeRepository ──────────────────────────────────

class MockMemoryNodeRepo {
  public created: CreateMemoryNodeInput[] = [];
  private counter = 0;

  createBatch(inputs: CreateMemoryNodeInput[]): MemoryNode[] {
    this.created.push(...inputs);
    return inputs.map((input) => ({
      id: `node-${++this.counter}`,
      nodeType: input.nodeType,
      nodeRole: input.nodeRole ?? 'leaf',
      frontmatter: input.frontmatter,
      keywords: input.keywords,
      metadata: input.metadata ?? {},
      summary: input.summary,
      sourceMessageIds: input.sourceMessageIds ?? [],
      conversationId: input.conversationId,
      sourceTurnIndex: input.sourceTurnIndex,
      createdAtEvent: input.currentEventCounter ?? 0,
      lastActivatedAtEvent: input.currentEventCounter ?? 0,
      activationCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }

  reset() {
    this.created = [];
    this.counter = 0;
  }
}

// ─── Mock GlobalEventCounter ────────────────────────────────────

class MockGlobalEventCounter {
  private value = 0;

  current(): number {
    return this.value;
  }

  setValue(v: number) {
    this.value = v;
  }
}

// ─── Test Fixtures ──────────────────────────────────────────────

/** Response with ALL 5 nodeTypes extracted in a single call */
const ALL_FIVE_TYPES_RESPONSE = JSON.stringify({
  nodes: [
    {
      nodeType: 'semantic',
      frontmatter: 'User prefers TypeScript for backend',
      summary: 'The user prefers TypeScript over JavaScript for backend development due to type safety.',
      searchKeywords: ['TypeScript', '타입스크립트', 'backend', '백엔드', 'type safety'],
      relatedEntities: ['TypeScript', 'JavaScript'],
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
      frontmatter: 'Deployed v2.0 to production',
      summary: 'The team deployed version 2.0 of the application to the production environment yesterday.',
      searchKeywords: ['deploy', '배포', 'v2.0', 'production', '프로덕션'],
      relatedEntities: ['production', 'v2.0'],
      metadata: {
        episodeType: 'event',
        actors: ['team', 'user'],
        outcome: 'successful deployment',
      },
    },
    {
      nodeType: 'procedural',
      frontmatter: 'How to deploy: build then push',
      summary: 'To deploy, first run the build command, then push the Docker image to the registry.',
      searchKeywords: ['deploy', '배포 방법', 'Docker', 'build', 'push', '도커'],
      relatedEntities: ['Docker', 'registry'],
      metadata: {
        steps: ['Run npm build', 'Build Docker image', 'Push to registry'],
        prerequisites: ['Docker installed', 'Registry access'],
      },
    },
    {
      nodeType: 'prospective',
      frontmatter: 'Plan: migrate to PostgreSQL next week',
      summary: 'The user plans to migrate the database from SQLite to PostgreSQL by next week.',
      searchKeywords: ['PostgreSQL', '포스트그레스', 'migration', '마이그레이션', 'database', '데이터베이스'],
      relatedEntities: ['PostgreSQL', 'SQLite'],
      metadata: {
        priority: 'high',
        status: 'pending',
        dueDate: '2026-03-25',
      },
    },
    {
      nodeType: 'emotional',
      frontmatter: 'User frustrated with slow build times',
      summary: 'The user expressed frustration about the slow build times affecting productivity.',
      searchKeywords: ['frustration', '좌절', 'build time', '빌드 시간', 'productivity'],
      relatedEntities: ['build system'],
      metadata: {
        emotion: 'frustration',
        intensity: 0.7,
        trigger: 'slow build times',
      },
    },
  ],
});

const SEMANTIC_ONLY_RESPONSE = JSON.stringify({
  nodes: [
    {
      nodeType: 'semantic',
      frontmatter: 'User likes Python',
      summary: 'The user prefers Python for data science.',
      searchKeywords: ['Python', '파이썬', 'data science', '데이터 사이언스'],
      relatedEntities: ['Python'],
      metadata: { category: 'preference', confidence: 0.9 },
    },
  ],
});

const EMPTY_RESPONSE = JSON.stringify({ nodes: [] });

function makeTurnEvent(
  conversationId: string,
  turnIndex: number,
  content: string,
  role: 'user' | 'assistant' = 'assistant',
): TurnCompletedEvent {
  return {
    type: 'turn.completed',
    conversationId,
    message: {
      conversationId,
      turnIndex,
      role,
      content,
      createdAt: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('MemoryNodeExtractionPipeline', () => {
  let eventBus: EventBus;
  let mockProvider: MockLLMProvider;
  let extractor: MemoryNodeExtractor;
  let nodeRepo: MockMemoryNodeRepo;
  let convRepo: MockConversationRepo;
  let counter: MockGlobalEventCounter;
  let pipeline: MemoryNodeExtractionPipeline;

  beforeEach(() => {
    eventBus = new EventBus();
    mockProvider = new MockLLMProvider();
    extractor = new MemoryNodeExtractor(mockProvider);
    nodeRepo = new MockMemoryNodeRepo();
    convRepo = new MockConversationRepo();
    counter = new MockGlobalEventCounter();

    pipeline = new MemoryNodeExtractionPipeline(
      eventBus,
      extractor,
      nodeRepo as any,
      convRepo as any,
      counter as any,
    );
  });

  // ── Core: Single LLM call extracts all 5 nodeTypes ──────────

  it('extracts all 5 nodeTypes in a single LLM call', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: '오늘 TypeScript 백엔드 배포했어. 빌드가 너무 느려서 좌절했고, 다음 주에 PostgreSQL로 마이그레이션할 계획이야.' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: '배포 축하합니다! 빌드 속도 개선도 함께 진행하시면 좋겠네요.' },
    ]);

    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);
    counter.setValue(42.0);

    const event = makeTurnEvent('c1', 1, '배포 축하합니다! 빌드 속도 개선도 함께 진행하시면 좋겠네요.');
    const result = await pipeline.handleTurnCompleted(event);

    expect(result.ok).toBe(true);
    expect(result.nodesCreated).toBe(5);
    expect(result.nodeTypes).toContain('semantic');
    expect(result.nodeTypes).toContain('episodic');
    expect(result.nodeTypes).toContain('procedural');
    expect(result.nodeTypes).toContain('prospective');
    expect(result.nodeTypes).toContain('emotional');

    // Verify exactly 1 LLM call was made (budget constraint)
    expect(mockProvider.calls).toHaveLength(1);
  });

  it('ensures 1-call/turn budget is respected across multiple turns', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'First user msg' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'First assistant msg' },
      { conversationId: 'c1', turnIndex: 2, role: 'user', content: 'Second user msg' },
      { conversationId: 'c1', turnIndex: 3, role: 'assistant', content: 'Second assistant msg' },
    ]);

    mockProvider.addResponse(SEMANTIC_ONLY_RESPONSE);
    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    // Process first turn
    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'First assistant msg'));
    expect(mockProvider.calls).toHaveLength(1);

    // Process second turn
    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 3, 'Second assistant msg'));
    expect(mockProvider.calls).toHaveLength(2); // 1 call per turn, total 2
  });

  // ── searchKeywords → L0 keywords ────────────────────────────

  it('maps searchKeywords to L0 keywords field (space-separated, 한영 혼용)', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'TypeScript를 선호해' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: '좋은 선택이네요!' },
    ]);

    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, '좋은 선택이네요!'));

    // Check the semantic node's keywords
    const semanticInput = nodeRepo.created.find((n) => n.nodeType === 'semantic')!;
    expect(semanticInput.keywords).toBe('TypeScript 타입스크립트 backend 백엔드 type safety');

    // Check Korean keywords for emotional node
    const emotionalInput = nodeRepo.created.find((n) => n.nodeType === 'emotional')!;
    expect(emotionalInput.keywords).toContain('좌절');
    expect(emotionalInput.keywords).toContain('frustration');
  });

  // ── relatedEntities → L1 metadata.entities ──────────────────

  it('maps relatedEntities to L1 metadata.entities', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'Test content' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'Response' },
    ]);

    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'Response'));

    const semanticInput = nodeRepo.created.find((n) => n.nodeType === 'semantic')!;
    expect(semanticInput.metadata!.entities).toContain('TypeScript');
    expect(semanticInput.metadata!.entities).toContain('JavaScript');

    const proceduralInput = nodeRepo.created.find((n) => n.nodeType === 'procedural')!;
    expect(proceduralInput.metadata!.entities).toContain('Docker');
    expect(proceduralInput.metadata!.entities).toContain('registry');
  });

  // ── Type-specific metadata validation ────────────────────────

  it('preserves semantic SPO triple in metadata', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'User msg' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'Asst msg' },
    ]);
    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'Asst msg'));

    const semantic = nodeRepo.created.find((n) => n.nodeType === 'semantic')!;
    expect(semantic.metadata!.subject).toBe('user');
    expect(semantic.metadata!.predicate).toBe('prefers');
    expect(semantic.metadata!.object).toBe('TypeScript');
  });

  it('preserves episodic metadata (actors, outcome)', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'U' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'A' },
    ]);
    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'A'));

    const episodic = nodeRepo.created.find((n) => n.nodeType === 'episodic')!;
    expect(episodic.metadata!.episodeType).toBe('event');
    expect(episodic.metadata!.actors).toEqual(['team', 'user']);
    expect(episodic.metadata!.outcome).toBe('successful deployment');
  });

  it('preserves procedural metadata (steps, prerequisites)', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'U' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'A' },
    ]);
    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'A'));

    const procedural = nodeRepo.created.find((n) => n.nodeType === 'procedural')!;
    expect(procedural.metadata!.steps).toEqual(['Run npm build', 'Build Docker image', 'Push to registry']);
    expect(procedural.metadata!.prerequisites).toEqual(['Docker installed', 'Registry access']);
  });

  it('preserves prospective metadata (priority, status, dueDate)', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'U' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'A' },
    ]);
    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'A'));

    const prospective = nodeRepo.created.find((n) => n.nodeType === 'prospective')!;
    expect(prospective.metadata!.priority).toBe('high');
    expect(prospective.metadata!.status).toBe('pending');
    expect(prospective.metadata!.dueDate).toBe('2026-03-25');
  });

  it('preserves emotional metadata (emotion, intensity, trigger)', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'U' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'A' },
    ]);
    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'A'));

    const emotional = nodeRepo.created.find((n) => n.nodeType === 'emotional')!;
    expect(emotional.metadata!.emotion).toBe('frustration');
    expect(emotional.metadata!.intensity).toBe(0.7);
    expect(emotional.metadata!.trigger).toBe('slow build times');
  });

  // ── Source references ────────────────────────────────────────

  it('sets correct source references (conversationId, turnIndex, sourceMessageIds)', async () => {
    convRepo.addMessages([
      { conversationId: 'conv-test', turnIndex: 0, role: 'user', content: 'User msg' },
      { conversationId: 'conv-test', turnIndex: 1, role: 'assistant', content: 'Asst msg' },
    ]);
    mockProvider.addResponse(SEMANTIC_ONLY_RESPONSE);

    await pipeline.handleTurnCompleted(makeTurnEvent('conv-test', 1, 'Asst msg'));

    const input = nodeRepo.created[0]!;
    expect(input.conversationId).toBe('conv-test');
    expect(input.sourceTurnIndex).toBe(0);
    expect(input.sourceMessageIds).toEqual(['conv-test:0', 'conv-test:1']);
  });

  // ── Event counter ────────────────────────────────────────────

  it('passes current event counter value to created nodes', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'U' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'A' },
    ]);
    mockProvider.addResponse(SEMANTIC_ONLY_RESPONSE);
    counter.setValue(99.5);

    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'A'));

    expect(nodeRepo.created[0]!.currentEventCounter).toBe(99.5);
  });

  // ── EventBus integration ─────────────────────────────────────

  it('emits memory-nodes.extracted event on success', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'U' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'A' },
    ]);
    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    const emitted: MemoryNodesExtractedEvent[] = [];
    eventBus.on<MemoryNodesExtractedEvent>('memory-nodes.extracted', (e) => {
      emitted.push(e);
    });

    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'A'));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.nodeCount).toBe(5);
    expect(emitted[0]!.conversationId).toBe('c1');
    expect(emitted[0]!.sourceTurnIndex).toBe(1);
    expect(emitted[0]!.nodeIds).toHaveLength(5);
    expect(emitted[0]!.nodeTypes).toContain('semantic');
    expect(emitted[0]!.nodeTypes).toContain('emotional');
  });

  it('emits extraction.error event on LLM failure', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'U' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'A' },
    ]);

    // Make LLM throw
    mockProvider.complete = async () => {
      throw new Error('LLM service unavailable');
    };

    const errors: ExtractionErrorEvent[] = [];
    eventBus.on<ExtractionErrorEvent>('extraction.error', (e) => {
      errors.push(e);
    });

    const result = await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'A'));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('LLM service unavailable');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toContain('LLM service unavailable');
  });

  it('triggers extraction via EventBus when started', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'Hello' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'Hi there' },
    ]);
    mockProvider.addResponse(SEMANTIC_ONLY_RESPONSE);

    pipeline.start();

    // Emit turn.completed through the event bus
    await eventBus.emit(makeTurnEvent('c1', 1, 'Hi there'));

    // Wait for async handler
    await new Promise((r) => setTimeout(r, 50));

    expect(nodeRepo.created).toHaveLength(1);
    expect(nodeRepo.created[0]!.nodeType).toBe('semantic');

    pipeline.stop();
  });

  // ── Edge cases ───────────────────────────────────────────────

  it('skips extraction for user messages', async () => {
    const result = await pipeline.handleTurnCompleted(
      makeTurnEvent('c1', 0, 'User message', 'user'),
    );

    expect(result.ok).toBe(true);
    expect(result.nodesCreated).toBe(0);
    expect(mockProvider.calls).toHaveLength(0);
  });

  it('skips extraction when no preceding user message found', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'assistant', content: 'System greeting' },
    ]);

    const result = await pipeline.handleTurnCompleted(makeTurnEvent('c1', 0, 'System greeting'));

    expect(result.ok).toBe(true);
    expect(result.nodesCreated).toBe(0);
    expect(mockProvider.calls).toHaveLength(0);
  });

  it('handles empty extraction (no nodes)', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'Hi' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'Hello!' },
    ]);
    mockProvider.addResponse(EMPTY_RESPONSE);

    const result = await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'Hello!'));

    expect(result.ok).toBe(true);
    expect(result.nodesCreated).toBe(0);
    expect(mockProvider.calls).toHaveLength(1); // LLM was still called
  });

  it('handles malformed LLM response gracefully', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'U' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'A' },
    ]);
    mockProvider.addResponse('completely invalid json {{{{');

    const result = await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'A'));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('JSON parse error');
  });

  // ── Prior context ────────────────────────────────────────────

  it('builds prior context from earlier messages', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'Earlier context' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'Earlier reply' },
      { conversationId: 'c1', turnIndex: 2, role: 'user', content: 'Current question' },
      { conversationId: 'c1', turnIndex: 3, role: 'assistant', content: 'Current answer' },
    ]);
    mockProvider.addResponse(SEMANTIC_ONLY_RESPONSE);

    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 3, 'Current answer'));

    // Check that the LLM call included prior context
    const llmCall = mockProvider.calls[0]!;
    expect(llmCall.prompt).toContain('Earlier context');
    expect(llmCall.prompt).toContain('Earlier reply');
  });

  // ── Pipeline without global counter ──────────────────────────

  it('works without GlobalEventCounter (defaults to 0)', async () => {
    const pipelineNoCounter = new MemoryNodeExtractionPipeline(
      eventBus,
      extractor,
      nodeRepo as any,
      convRepo as any,
      undefined, // no counter
    );

    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'U' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'A' },
    ]);
    mockProvider.addResponse(SEMANTIC_ONLY_RESPONSE);

    const result = await pipelineNoCounter.handleTurnCompleted(makeTurnEvent('c1', 1, 'A'));

    expect(result.ok).toBe(true);
    expect(result.nodesCreated).toBe(1);
    expect(nodeRepo.created[0]!.currentEventCounter).toBe(0);
  });

  // ── All nodeRole set to 'leaf' by default ────────────────────

  it('all extracted nodes default to leaf role', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'U' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'A' },
    ]);
    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    await pipeline.handleTurnCompleted(makeTurnEvent('c1', 1, 'A'));

    for (const input of nodeRepo.created) {
      expect(input.nodeRole).toBe('leaf');
    }
  });

  // ── stop() prevents further extraction ───────────────────────

  it('stop() unsubscribes from events', async () => {
    convRepo.addMessages([
      { conversationId: 'c1', turnIndex: 0, role: 'user', content: 'U' },
      { conversationId: 'c1', turnIndex: 1, role: 'assistant', content: 'A' },
    ]);
    mockProvider.addResponse(SEMANTIC_ONLY_RESPONSE);

    pipeline.start();
    pipeline.stop();

    await eventBus.emit(makeTurnEvent('c1', 1, 'A'));
    await new Promise((r) => setTimeout(r, 50));

    // No extraction should have happened
    expect(nodeRepo.created).toHaveLength(0);
    expect(mockProvider.calls).toHaveLength(0);
  });
});

// ─── Extractor Unit Tests (single LLM call coverage) ───────────

describe('MemoryNodeExtractor - all nodeTypes in single call', () => {
  let mockProvider: MockLLMProvider;
  let extractor: MemoryNodeExtractor;

  beforeEach(() => {
    mockProvider = new MockLLMProvider();
    extractor = new MemoryNodeExtractor(mockProvider);
  });

  it('extracts all 5 nodeTypes from single LLM response', async () => {
    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    const result = await extractor.extractFromTurn({
      conversationId: 'c1',
      userMessage: { content: '복합 메시지', turnIndex: 0 },
      assistantMessage: { content: '복합 응답', turnIndex: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.nodes).toHaveLength(5);
    expect(mockProvider.calls).toHaveLength(1); // Single call

    const types = new Set(result.nodes.map((n) => n.nodeType));
    expect(types.size).toBe(5);
    expect(types.has('semantic')).toBe(true);
    expect(types.has('episodic')).toBe(true);
    expect(types.has('procedural')).toBe(true);
    expect(types.has('prospective')).toBe(true);
    expect(types.has('emotional')).toBe(true);
  });

  it('each node has both searchKeywords and relatedEntities', async () => {
    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    const result = await extractor.extractFromTurn({
      conversationId: 'c1',
      userMessage: { content: 'msg', turnIndex: 0 },
      assistantMessage: { content: 'reply', turnIndex: 1 },
    });

    for (const node of result.nodes) {
      expect(Array.isArray(node.searchKeywords)).toBe(true);
      expect(Array.isArray(node.relatedEntities)).toBe(true);
      expect(node.keywords.length).toBeGreaterThan(0);
    }
  });

  it('createInputs have extractionModel in metadata', async () => {
    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    const result = await extractor.extractFromTurn({
      conversationId: 'c1',
      userMessage: { content: 'msg', turnIndex: 0 },
      assistantMessage: { content: 'reply', turnIndex: 1 },
    });

    for (const input of result.createInputs) {
      expect(input.metadata!.extractionModel).toBe('mock');
    }
  });

  it('bilingual keywords preserved in L0', async () => {
    mockProvider.addResponse(ALL_FIVE_TYPES_RESPONSE);

    const result = await extractor.extractFromTurn({
      conversationId: 'c1',
      userMessage: { content: '한글 메시지', turnIndex: 0 },
      assistantMessage: { content: 'English reply', turnIndex: 1 },
    });

    // Check semantic node has both Korean and English keywords
    const semantic = result.nodes.find((n) => n.nodeType === 'semantic')!;
    expect(semantic.searchKeywords).toContain('TypeScript');
    expect(semantic.searchKeywords).toContain('타입스크립트');

    // Check emotional node
    const emotional = result.nodes.find((n) => n.nodeType === 'emotional')!;
    expect(emotional.searchKeywords).toContain('좌절');
    expect(emotional.searchKeywords).toContain('frustration');
  });
});
