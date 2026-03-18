/**
 * Integration test: TraceTimeline ↔ DetailPanel interaction with MemoryNode data flow.
 *
 * Validates:
 * - Stage aggregation correctly processes MemoryNode-based ingestion/recall trace events
 * - Selection/deselection flow: clicking a stage populates DetailPanel entry
 * - MemoryNode 4-layer progressive depth data appears in trace output payloads
 * - Hub/leaf nodeRole and nodeType classification flows through traces
 * - Error/skipped/running states correctly propagate to DetailPanel
 * - FTS5+vector hybrid search trace data includes MemoryNode references
 * - 한영 혼용 data in MemoryNode traces preserved through pipeline
 */

import { describe, it, expect } from 'vitest';

// ─── Re-implement timeline aggregation logic (mirrors web/src/components/TimelinePanel.tsx) ───
// We test the pure data-flow logic that drives the UI interaction,
// not the React rendering itself (which would require jsdom + React Testing Library).

/** Minimal TraceEvent matching web/src/types.ts */
interface TraceEvent {
  stage: string;
  status: 'start' | 'complete' | 'error' | 'skipped';
  durationMs?: number;
  data?: Record<string, unknown>;
  timestamp: string;
}

/** Minimal StageEntry matching web/src/types/timeline.ts */
interface StageEntry {
  stage: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  durationMs?: number;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorMessage?: string;
  skipReason?: string;
  startedAt?: string;
  completedAt?: string;
  parentStage?: string;
  isTopLevel: boolean;
}

// ─── Stage classification (mirrors web/src/types/timeline.ts) ───

const TOP_LEVEL_STAGES = new Set([
  'pipeline', 'recall', 'llm', 'ingestion', 'session_end', 'batch_extraction',
]);

const RECALL_SUB_STAGES = new Set([
  'vector_search', 'graph_traversal', 'merge', 'reinforce', 'format', 'inject',
]);

const BATCH_SUB_STAGES = new Set([
  'episode_extraction', 'concept_extraction',
]);

const PIPELINE_STAGE_ORDER = [
  'pipeline', 'recall', 'vector_search', 'graph_traversal', 'merge',
  'reinforce', 'format', 'inject', 'llm', 'ingestion',
  'session_end', 'batch_extraction', 'episode_extraction', 'concept_extraction',
];

function getStageOrder(stage: string): number {
  const idx = PIPELINE_STAGE_ORDER.indexOf(stage);
  return idx === -1 ? 999 : idx;
}

/**
 * Aggregates raw trace events into StageEntry objects.
 * This is the exact logic from TimelinePanel.tsx and ChatPage.tsx
 * that drives the DetailPanel display.
 */
function aggregateStages(traces: TraceEvent[]): StageEntry[] {
  const stageMap = new Map<string, StageEntry>();

  for (const trace of traces) {
    const existing = stageMap.get(trace.stage);

    if (trace.status === 'start') {
      stageMap.set(trace.stage, {
        stage: trace.stage,
        status: 'running',
        startedAt: trace.timestamp,
        input: trace.data as Record<string, unknown> | undefined,
        parentStage: RECALL_SUB_STAGES.has(trace.stage) ? 'recall'
          : BATCH_SUB_STAGES.has(trace.stage) ? 'batch_extraction'
          : undefined,
        isTopLevel: TOP_LEVEL_STAGES.has(trace.stage),
      });
    } else if (trace.status === 'complete') {
      const entry = existing ?? {
        stage: trace.stage,
        status: 'done' as const,
        parentStage: RECALL_SUB_STAGES.has(trace.stage) ? 'recall'
          : BATCH_SUB_STAGES.has(trace.stage) ? 'batch_extraction'
          : undefined,
        isTopLevel: TOP_LEVEL_STAGES.has(trace.stage),
      };
      stageMap.set(trace.stage, {
        ...entry,
        status: 'done',
        durationMs: trace.durationMs,
        completedAt: trace.timestamp,
        output: trace.data as Record<string, unknown> | undefined,
      });
    } else if (trace.status === 'error') {
      const entry = existing ?? {
        stage: trace.stage,
        status: 'error' as const,
        parentStage: RECALL_SUB_STAGES.has(trace.stage) ? 'recall'
          : BATCH_SUB_STAGES.has(trace.stage) ? 'batch_extraction'
          : undefined,
        isTopLevel: TOP_LEVEL_STAGES.has(trace.stage),
      };
      stageMap.set(trace.stage, {
        ...entry,
        status: 'error',
        durationMs: trace.durationMs,
        completedAt: trace.timestamp,
        errorMessage: (trace.data as Record<string, unknown>)?.error as string
          ?? (trace.data as Record<string, unknown>)?.message as string
          ?? 'Unknown error',
      });
    } else if (trace.status === 'skipped') {
      stageMap.set(trace.stage, {
        stage: trace.stage,
        status: 'skipped',
        startedAt: trace.timestamp,
        completedAt: trace.timestamp,
        skipReason: (trace.data as Record<string, unknown>)?.reason as string
          ?? (trace.data as Record<string, unknown>)?.skipReason as string
          ?? 'Skipped',
        parentStage: RECALL_SUB_STAGES.has(trace.stage) ? 'recall'
          : BATCH_SUB_STAGES.has(trace.stage) ? 'batch_extraction'
          : undefined,
        isTopLevel: TOP_LEVEL_STAGES.has(trace.stage),
      });
    }
  }

  return Array.from(stageMap.values()).sort(
    (a, b) => getStageOrder(a.stage) - getStageOrder(b.stage),
  );
}

/**
 * Simulates the ChatPage selection logic:
 * - Click on a stage → selectedStage set
 * - Look up StageEntry from aggregated stageMap
 * - Pass to DetailPanel as entry prop
 */
function resolveSelectedEntry(
  stageEntries: Map<string, StageEntry>,
  selectedStage: string | null,
): StageEntry | null {
  return selectedStage ? stageEntries.get(selectedStage) ?? null : null;
}

/**
 * Simulates the ChatPage toggle behavior:
 * clicking the same stage deselects, clicking a new stage selects it.
 */
function toggleSelection(
  currentSelection: string | null,
  clickedStage: string,
): string | null {
  return clickedStage === currentSelection ? null : clickedStage;
}

// ─── Test Fixtures ───────────────────────────────────────────

/** Creates a full pipeline trace sequence with MemoryNode data */
function createMemoryNodePipelineTraces(): TraceEvent[] {
  const baseTime = '2026-03-18T10:00:00.000Z';
  const t = (offsetMs: number) =>
    new Date(new Date(baseTime).getTime() + offsetMs).toISOString();

  return [
    // Pipeline start
    { stage: 'pipeline', status: 'start', timestamp: t(0) },

    // Recall stage with MemoryNode-based vector search
    { stage: 'recall', status: 'start', timestamp: t(10) },
    {
      stage: 'vector_search',
      status: 'start',
      timestamp: t(20),
      data: {
        queryText: '사용자가 좋아하는 프로그래밍 언어',
        topK: 20,
        ftsMaxCandidates: 200,
        searchMode: 'hybrid_fts_vector',
      },
    },
    {
      stage: 'vector_search',
      status: 'complete',
      durationMs: 45,
      timestamp: t(65),
      data: {
        matchedNodes: [
          {
            id: 'mn-001',
            nodeType: 'semantic',
            nodeRole: 'leaf',
            frontmatter: '사용자는 TypeScript를 선호함',
            similarity: 0.92,
            keywords: 'typescript 프로그래밍 선호 언어',
          },
          {
            id: 'mn-002',
            nodeType: 'semantic',
            nodeRole: 'hub',
            frontmatter: '프로그래밍 언어 preferences',
            similarity: 0.88,
            keywords: '프로그래밍 언어 programming language',
          },
        ],
        ftsCandidateCount: 15,
        vectorRerankCount: 10,
        totalNodeCount: 2,
      },
    },
    {
      stage: 'graph_traversal',
      status: 'start',
      timestamp: t(70),
      data: {
        queryText: '사용자가 좋아하는 프로그래밍 언어',
        seedNodeIds: ['mn-002'],
        maxHops: 2,
      },
    },
    {
      stage: 'graph_traversal',
      status: 'complete',
      durationMs: 30,
      timestamp: t(100),
      data: {
        traversedNodes: [
          { id: 'mn-003', nodeType: 'episodic', nodeRole: 'leaf', frontmatter: 'TypeScript 프로젝트 설정 경험' },
          { id: 'mn-004', nodeType: 'procedural', nodeRole: 'leaf', frontmatter: 'React + TS 설정 가이드' },
        ],
        edgesTraversed: 5,
        hopsUsed: 2,
      },
    },
    {
      stage: 'merge',
      status: 'start',
      timestamp: t(105),
      data: { vectorItemCount: 2, graphItemCount: 2 },
    },
    {
      stage: 'merge',
      status: 'complete',
      durationMs: 5,
      timestamp: t(110),
      data: {
        mergedItemCount: 3,
        overlapCount: 1,
        filteredCount: 0,
        mergedNodes: [
          { id: 'mn-001', score: 0.92, source: 'vector' },
          { id: 'mn-003', score: 0.78, source: 'graph' },
          { id: 'mn-004', score: 0.72, source: 'graph' },
        ],
      },
    },
    {
      stage: 'reinforce',
      status: 'start',
      timestamp: t(115),
      data: { hubNodeIds: ['mn-002'], resultCount: 3, learningRate: 0.1 },
    },
    {
      stage: 'reinforce',
      status: 'complete',
      durationMs: 8,
      timestamp: t(123),
      data: {
        edgesReinforced: 4,
        shieldGained: 2,
        weightOverflow: 1,
      },
    },
    {
      stage: 'format',
      status: 'start',
      timestamp: t(125),
      data: { itemCount: 3, format: 'xml', maxChars: 4000 },
    },
    {
      stage: 'format',
      status: 'complete',
      durationMs: 3,
      timestamp: t(128),
      data: {
        charCount: 850,
        truncated: false,
        itemsIncluded: 3,
        progressiveDepth: {
          L0_nodes: 3,
          L1_nodes: 2,
          L2_nodes: 1,
        },
      },
    },
    {
      stage: 'inject',
      status: 'start',
      timestamp: t(130),
      data: { hasMemoryContext: true, contextCharCount: 850 },
    },
    {
      stage: 'inject',
      status: 'complete',
      durationMs: 1,
      timestamp: t(131),
      data: { finalPromptLength: 1200 },
    },
    { stage: 'recall', status: 'complete', durationMs: 121, timestamp: t(131) },

    // LLM stage
    { stage: 'llm', status: 'start', timestamp: t(135) },
    { stage: 'llm', status: 'complete', durationMs: 500, timestamp: t(635) },

    // Ingestion stage with MemoryNode extraction results
    {
      stage: 'ingestion',
      status: 'start',
      timestamp: t(640),
      data: {
        userMessage: '내가 좋아하는 프로그래밍 언어는 뭐야?',
        assistantResponseLength: 150,
        mode: 'memoryNodeExtractor',
      },
    },
    {
      stage: 'ingestion',
      status: 'complete',
      durationMs: 200,
      timestamp: t(840),
      data: {
        extractedNodeCount: 2,
        extractedNodes: [
          {
            id: 'mn-005',
            nodeType: 'semantic',
            nodeRole: 'leaf',
            frontmatter: '사용자가 좋아하는 언어에 대한 질문',
            keywords: '좋아하는 프로그래밍 언어 질문',
            metadata: {
              category: 'preference-inquiry',
              confidence: 0.85,
              entities: ['프로그래밍 언어'],
              subject: '사용자',
              predicate: '질문',
              object: '좋아하는 프로그래밍 언어',
            },
            summary: '사용자가 자신이 좋아하는 프로그래밍 언어에 대해 물었다.',
            sourceMessageIds: ['conv-123:0'],
          },
          {
            id: 'mn-006',
            nodeType: 'episodic',
            nodeRole: 'leaf',
            frontmatter: '언어 선호도 대화 에피소드',
            keywords: '대화 에피소드 언어 선호',
            metadata: {
              episodeType: 'event',
              actors: ['사용자', 'assistant'],
              confidence: 0.9,
            },
            summary: '사용자와 어시스턴트가 프로그래밍 언어 선호도에 대해 대화했다.',
            sourceMessageIds: ['conv-123:0', 'conv-123:1'],
          },
        ],
        hubsCreated: 0,
        hubsLinked: 1,
        linkedHubId: 'mn-002',
      },
    },

    // Pipeline complete
    { stage: 'pipeline', status: 'complete', durationMs: 840, timestamp: t(840) },
  ];
}

/** Creates trace events for an ingestion with hub creation */
function createHubCreationTraces(): TraceEvent[] {
  const baseTime = '2026-03-18T11:00:00.000Z';
  const t = (offsetMs: number) =>
    new Date(new Date(baseTime).getTime() + offsetMs).toISOString();

  return [
    { stage: 'pipeline', status: 'start', timestamp: t(0) },
    {
      stage: 'ingestion',
      status: 'start',
      timestamp: t(100),
      data: {
        userMessage: 'Docker에 대해 알려줘',
        assistantResponseLength: 300,
        mode: 'memoryNodeExtractor',
      },
    },
    {
      stage: 'ingestion',
      status: 'complete',
      durationMs: 250,
      timestamp: t(350),
      data: {
        extractedNodeCount: 3,
        extractedNodes: [
          {
            id: 'mn-010',
            nodeType: null,
            nodeRole: 'hub',
            frontmatter: 'Docker',
            keywords: 'docker 컨테이너 container devops',
            metadata: {
              hubType: 'topic',
              aliases: ['도커', 'docker-engine'],
              relevance: 0.95,
            },
            summary: 'Docker 컨테이너 기술 허브 노드',
          },
          {
            id: 'mn-011',
            nodeType: 'semantic',
            nodeRole: 'leaf',
            frontmatter: 'Docker는 컨테이너 가상화 플랫폼이다',
            keywords: 'docker 컨테이너 가상화 플랫폼',
            metadata: {
              category: 'technical',
              confidence: 0.95,
              subject: 'Docker',
              predicate: 'is',
              object: '컨테이너 가상화 플랫폼',
            },
            summary: 'Docker는 애플리케이션을 컨테이너로 패키징하고 배포하는 플랫폼이다.',
          },
          {
            id: 'mn-012',
            nodeType: 'procedural',
            nodeRole: 'leaf',
            frontmatter: 'Docker 기본 사용법',
            keywords: 'docker 사용법 dockerfile 이미지 빌드',
            metadata: {
              steps: ['Dockerfile 작성', 'docker build', 'docker run'],
              prerequisites: ['Docker 설치'],
            },
            summary: 'Docker 이미지 빌드 및 실행 절차',
          },
        ],
        hubsCreated: 1,
        hubCreationDetails: {
          hubId: 'mn-010',
          method: 'hybrid_fts_cosine',
          ftsMatch: false,
          cosineSimilarity: 0.72,
          threshold: 0.85,
          decision: 'new_hub_created',
        },
      },
    },
    { stage: 'pipeline', status: 'complete', durationMs: 350, timestamp: t(350) },
  ];
}

/** Creates trace events with error and skipped stages */
function createErrorAndSkippedTraces(): TraceEvent[] {
  const baseTime = '2026-03-18T12:00:00.000Z';
  const t = (offsetMs: number) =>
    new Date(new Date(baseTime).getTime() + offsetMs).toISOString();

  return [
    { stage: 'pipeline', status: 'start', timestamp: t(0) },
    { stage: 'recall', status: 'start', timestamp: t(10) },
    {
      stage: 'vector_search',
      status: 'error',
      durationMs: 100,
      timestamp: t(110),
      data: { error: 'Embedding model not loaded' },
    },
    {
      stage: 'graph_traversal',
      status: 'skipped',
      timestamp: t(115),
      data: { reason: 'No seed nodes from failed vector search' },
    },
    {
      stage: 'merge',
      status: 'skipped',
      timestamp: t(116),
      data: { skipReason: 'No items to merge' },
    },
    {
      stage: 'reinforce',
      status: 'skipped',
      timestamp: t(117),
      data: { reason: 'No recall results' },
    },
    {
      stage: 'format',
      status: 'skipped',
      timestamp: t(118),
      data: { reason: 'No context to format' },
    },
    {
      stage: 'inject',
      status: 'complete',
      durationMs: 1,
      timestamp: t(119),
      data: { hasMemoryContext: false, finalPromptLength: 200 },
    },
    {
      stage: 'recall',
      status: 'error',
      durationMs: 109,
      timestamp: t(119),
      data: { error: 'Recall failed: vector search error' },
    },
    { stage: 'llm', status: 'start', timestamp: t(120) },
    { stage: 'llm', status: 'complete', durationMs: 400, timestamp: t(520) },
    { stage: 'pipeline', status: 'complete', durationMs: 520, timestamp: t(520) },
  ];
}

// ─── Tests ───────────────────────────────────────────────────

describe('TraceTimeline ↔ DetailPanel Integration (MemoryNode data flow)', () => {
  // ── Stage Aggregation with MemoryNode Data ──

  describe('Stage aggregation with MemoryNode trace data', () => {
    it('aggregates a full MemoryNode pipeline into correct StageEntries', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);

      // All stages present
      const stageNames = stages.map((s) => s.stage);
      expect(stageNames).toContain('pipeline');
      expect(stageNames).toContain('recall');
      expect(stageNames).toContain('vector_search');
      expect(stageNames).toContain('graph_traversal');
      expect(stageNames).toContain('merge');
      expect(stageNames).toContain('reinforce');
      expect(stageNames).toContain('format');
      expect(stageNames).toContain('inject');
      expect(stageNames).toContain('llm');
      expect(stageNames).toContain('ingestion');

      // All completed
      for (const stage of stages) {
        expect(stage.status).toBe('done');
      }
    });

    it('preserves MemoryNode search results in vector_search output', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);

      const vectorSearch = stages.find((s) => s.stage === 'vector_search')!;
      expect(vectorSearch.output).toBeDefined();
      expect(vectorSearch.output!.matchedNodes).toBeDefined();

      const matchedNodes = vectorSearch.output!.matchedNodes as Array<Record<string, unknown>>;
      expect(matchedNodes).toHaveLength(2);

      // Verify MemoryNode fields are preserved
      expect(matchedNodes[0].nodeType).toBe('semantic');
      expect(matchedNodes[0].nodeRole).toBe('leaf');
      expect(matchedNodes[0].frontmatter).toBe('사용자는 TypeScript를 선호함');
      expect(matchedNodes[0].similarity).toBe(0.92);
      expect(matchedNodes[0].keywords).toBe('typescript 프로그래밍 선호 언어');

      // Hub node
      expect(matchedNodes[1].nodeType).toBe('semantic');
      expect(matchedNodes[1].nodeRole).toBe('hub');
    });

    it('preserves MemoryNode extraction results in ingestion output', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);

      const ingestion = stages.find((s) => s.stage === 'ingestion')!;
      expect(ingestion.output).toBeDefined();
      expect(ingestion.output!.extractedNodeCount).toBe(2);

      const nodes = ingestion.output!.extractedNodes as Array<Record<string, unknown>>;
      expect(nodes).toHaveLength(2);

      // First node: semantic leaf
      expect(nodes[0].nodeType).toBe('semantic');
      expect(nodes[0].nodeRole).toBe('leaf');
      expect(nodes[0].frontmatter).toBe('사용자가 좋아하는 언어에 대한 질문');

      // L1 metadata preserved
      const meta0 = nodes[0].metadata as Record<string, unknown>;
      expect(meta0.category).toBe('preference-inquiry');
      expect(meta0.confidence).toBe(0.85);
      expect(meta0.subject).toBe('사용자');
      expect(meta0.predicate).toBe('질문');
      expect(meta0.object).toBe('좋아하는 프로그래밍 언어');

      // L3 sourceMessageIds
      expect(nodes[0].sourceMessageIds).toEqual(['conv-123:0']);

      // Second node: episodic leaf
      expect(nodes[1].nodeType).toBe('episodic');
      expect(nodes[1].sourceMessageIds).toEqual(['conv-123:0', 'conv-123:1']);
    });

    it('preserves progressive depth info in format output', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);

      const format = stages.find((s) => s.stage === 'format')!;
      expect(format.output).toBeDefined();
      expect(format.output!.progressiveDepth).toBeDefined();

      const depth = format.output!.progressiveDepth as Record<string, number>;
      expect(depth.L0_nodes).toBe(3);
      expect(depth.L1_nodes).toBe(2);
      expect(depth.L2_nodes).toBe(1);
    });

    it('preserves shield+weight decay data in reinforce output', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);

      const reinforce = stages.find((s) => s.stage === 'reinforce')!;
      expect(reinforce.output).toBeDefined();
      expect(reinforce.output!.edgesReinforced).toBe(4);
      expect(reinforce.output!.shieldGained).toBe(2);
      expect(reinforce.output!.weightOverflow).toBe(1);
    });

    it('preserves input data from start events', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);

      const vectorSearch = stages.find((s) => s.stage === 'vector_search')!;
      expect(vectorSearch.input).toBeDefined();
      expect(vectorSearch.input!.queryText).toBe('사용자가 좋아하는 프로그래밍 언어');
      expect(vectorSearch.input!.searchMode).toBe('hybrid_fts_vector');
      expect(vectorSearch.input!.ftsMaxCandidates).toBe(200);
    });
  });

  // ── Hub Creation in Ingestion ──

  describe('Hub creation trace data flow', () => {
    it('includes hub creation details with nodeRole=hub and null nodeType', () => {
      const traces = createHubCreationTraces();
      const stages = aggregateStages(traces);

      const ingestion = stages.find((s) => s.stage === 'ingestion')!;
      expect(ingestion.output).toBeDefined();

      const nodes = ingestion.output!.extractedNodes as Array<Record<string, unknown>>;
      expect(nodes).toHaveLength(3);

      // Hub node: nodeType=null, nodeRole=hub
      const hub = nodes.find((n) => n.nodeRole === 'hub')!;
      expect(hub).toBeDefined();
      expect(hub.nodeType).toBeNull();
      expect(hub.frontmatter).toBe('Docker');

      const hubMeta = hub.metadata as Record<string, unknown>;
      expect(hubMeta.hubType).toBe('topic');
      expect(hubMeta.aliases).toEqual(['도커', 'docker-engine']);
    });

    it('includes hub creation method details (hybrid FTS+cosine)', () => {
      const traces = createHubCreationTraces();
      const stages = aggregateStages(traces);

      const ingestion = stages.find((s) => s.stage === 'ingestion')!;
      const details = ingestion.output!.hubCreationDetails as Record<string, unknown>;
      expect(details).toBeDefined();
      expect(details.method).toBe('hybrid_fts_cosine');
      expect(details.decision).toBe('new_hub_created');
      expect(details.cosineSimilarity).toBe(0.72);
      expect(details.threshold).toBe(0.85);
    });

    it('preserves procedural node with steps in metadata', () => {
      const traces = createHubCreationTraces();
      const stages = aggregateStages(traces);

      const ingestion = stages.find((s) => s.stage === 'ingestion')!;
      const nodes = ingestion.output!.extractedNodes as Array<Record<string, unknown>>;
      const proc = nodes.find((n) => n.nodeType === 'procedural')!;
      expect(proc).toBeDefined();

      const meta = proc.metadata as Record<string, unknown>;
      expect(meta.steps).toEqual(['Dockerfile 작성', 'docker build', 'docker run']);
      expect(meta.prerequisites).toEqual(['Docker 설치']);
    });
  });

  // ── Selection/Deselection Flow ──

  describe('Stage selection and DetailPanel resolution', () => {
    it('selects a stage and resolves its StageEntry for DetailPanel', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);
      const stageMap = new Map(stages.map((s) => [s.stage, s]));

      // Simulate clicking vector_search
      let selectedStage: string | null = null;
      selectedStage = toggleSelection(selectedStage, 'vector_search');
      expect(selectedStage).toBe('vector_search');

      const entry = resolveSelectedEntry(stageMap, selectedStage);
      expect(entry).not.toBeNull();
      expect(entry!.stage).toBe('vector_search');
      expect(entry!.status).toBe('done');
      expect(entry!.durationMs).toBe(45);
      expect(entry!.isTopLevel).toBe(false);
      expect(entry!.parentStage).toBe('recall');

      // Output contains MemoryNode data
      expect(entry!.output!.matchedNodes).toBeDefined();
    });

    it('deselects on second click (toggle behavior)', () => {
      let selectedStage: string | null = null;

      selectedStage = toggleSelection(selectedStage, 'ingestion');
      expect(selectedStage).toBe('ingestion');

      selectedStage = toggleSelection(selectedStage, 'ingestion');
      expect(selectedStage).toBeNull();

      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);
      const stageMap = new Map(stages.map((s) => [s.stage, s]));

      const entry = resolveSelectedEntry(stageMap, selectedStage);
      expect(entry).toBeNull();
    });

    it('switches selection between stages', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);
      const stageMap = new Map(stages.map((s) => [s.stage, s]));

      let selectedStage: string | null = null;

      // Click vector_search
      selectedStage = toggleSelection(selectedStage, 'vector_search');
      let entry = resolveSelectedEntry(stageMap, selectedStage);
      expect(entry!.stage).toBe('vector_search');
      expect(entry!.output!.matchedNodes).toBeDefined();

      // Click ingestion (switches, doesn't deselect)
      selectedStage = toggleSelection(selectedStage, 'ingestion');
      entry = resolveSelectedEntry(stageMap, selectedStage);
      expect(entry!.stage).toBe('ingestion');
      expect(entry!.output!.extractedNodes).toBeDefined();

      // Click ingestion again (deselects)
      selectedStage = toggleSelection(selectedStage, 'ingestion');
      entry = resolveSelectedEntry(stageMap, selectedStage);
      expect(entry).toBeNull();
    });

    it('returns null for non-existent stage', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);
      const stageMap = new Map(stages.map((s) => [s.stage, s]));

      const entry = resolveSelectedEntry(stageMap, 'nonexistent_stage');
      expect(entry).toBeNull();
    });
  });

  // ── Error and Skipped States ──

  describe('Error and skipped stage propagation to DetailPanel', () => {
    it('aggregates error stages with errorMessage', () => {
      const traces = createErrorAndSkippedTraces();
      const stages = aggregateStages(traces);

      const vectorSearch = stages.find((s) => s.stage === 'vector_search')!;
      expect(vectorSearch.status).toBe('error');
      expect(vectorSearch.errorMessage).toBe('Embedding model not loaded');
      expect(vectorSearch.durationMs).toBe(100);
    });

    it('aggregates skipped stages with skipReason', () => {
      const traces = createErrorAndSkippedTraces();
      const stages = aggregateStages(traces);

      const graphTraversal = stages.find((s) => s.stage === 'graph_traversal')!;
      expect(graphTraversal.status).toBe('skipped');
      expect(graphTraversal.skipReason).toBe('No seed nodes from failed vector search');

      // skipReason from alternate field
      const merge = stages.find((s) => s.stage === 'merge')!;
      expect(merge.status).toBe('skipped');
      expect(merge.skipReason).toBe('No items to merge');
    });

    it('error stage in DetailPanel resolves with full error data', () => {
      const traces = createErrorAndSkippedTraces();
      const stages = aggregateStages(traces);
      const stageMap = new Map(stages.map((s) => [s.stage, s]));

      const entry = resolveSelectedEntry(stageMap, 'recall');
      expect(entry).not.toBeNull();
      expect(entry!.status).toBe('error');
      expect(entry!.errorMessage).toBe('Recall failed: vector search error');
      expect(entry!.isTopLevel).toBe(true);
    });

    it('skipped sub-stage correctly has parent reference', () => {
      const traces = createErrorAndSkippedTraces();
      const stages = aggregateStages(traces);

      const skippedStages = stages.filter((s) => s.status === 'skipped');
      for (const s of skippedStages) {
        if (RECALL_SUB_STAGES.has(s.stage)) {
          expect(s.parentStage).toBe('recall');
          expect(s.isTopLevel).toBe(false);
        }
      }
    });
  });

  // ── Stage Ordering and Hierarchy ──

  describe('Stage ordering and hierarchy for timeline display', () => {
    it('sorts stages in pipeline order', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);
      const names = stages.map((s) => s.stage);

      // Verify pipeline order is maintained
      const pipelineIdx = names.indexOf('pipeline');
      const recallIdx = names.indexOf('recall');
      const vectorIdx = names.indexOf('vector_search');
      const llmIdx = names.indexOf('llm');
      const ingestionIdx = names.indexOf('ingestion');

      expect(pipelineIdx).toBeLessThan(recallIdx);
      expect(recallIdx).toBeLessThan(vectorIdx);
      expect(vectorIdx).toBeLessThan(llmIdx);
      expect(llmIdx).toBeLessThan(ingestionIdx);
    });

    it('correctly classifies top-level vs nested stages', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);

      const topLevel = stages.filter((s) => s.isTopLevel);
      const nested = stages.filter((s) => !s.isTopLevel);

      // Top-level stages
      expect(topLevel.map((s) => s.stage)).toEqual(
        expect.arrayContaining(['pipeline', 'recall', 'llm', 'ingestion']),
      );

      // Nested recall sub-stages
      const recallSubs = nested.filter((s) => s.parentStage === 'recall');
      expect(recallSubs.map((s) => s.stage)).toEqual(
        expect.arrayContaining(['vector_search', 'graph_traversal', 'merge', 'reinforce', 'format', 'inject']),
      );
    });
  });

  // ── Running (in-progress) State ──

  describe('Running state for in-progress stages', () => {
    it('shows running status when only start event received', () => {
      const traces: TraceEvent[] = [
        { stage: 'pipeline', status: 'start', timestamp: '2026-03-18T10:00:00Z' },
        { stage: 'recall', status: 'start', timestamp: '2026-03-18T10:00:00.010Z' },
        {
          stage: 'vector_search',
          status: 'start',
          timestamp: '2026-03-18T10:00:00.020Z',
          data: {
            queryText: '검색 중...',
            searchMode: 'hybrid_fts_vector',
          },
        },
      ];

      const stages = aggregateStages(traces);

      expect(stages.find((s) => s.stage === 'pipeline')!.status).toBe('running');
      expect(stages.find((s) => s.stage === 'recall')!.status).toBe('running');
      expect(stages.find((s) => s.stage === 'vector_search')!.status).toBe('running');

      // Input data preserved for running stage
      const vs = stages.find((s) => s.stage === 'vector_search')!;
      expect(vs.input!.queryText).toBe('검색 중...');
    });
  });

  // ── 한영 혼용 Data Preservation ──

  describe('한영 혼용 (Korean+English) data preservation', () => {
    it('preserves Korean text in MemoryNode frontmatter through aggregation', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);

      const ingestion = stages.find((s) => s.stage === 'ingestion')!;
      const nodes = ingestion.output!.extractedNodes as Array<Record<string, unknown>>;

      // Korean frontmatter preserved
      expect(nodes[0].frontmatter).toBe('사용자가 좋아하는 언어에 대한 질문');
      expect(nodes[1].frontmatter).toBe('언어 선호도 대화 에피소드');

      // Mixed Korean+English keywords preserved
      expect(nodes[0].keywords).toBe('좋아하는 프로그래밍 언어 질문');
    });

    it('preserves Korean input queryText for vector search', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);

      const vs = stages.find((s) => s.stage === 'vector_search')!;
      expect(vs.input!.queryText).toBe('사용자가 좋아하는 프로그래밍 언어');
    });

    it('preserves Korean+English mixed keywords in hub creation', () => {
      const traces = createHubCreationTraces();
      const stages = aggregateStages(traces);

      const ingestion = stages.find((s) => s.stage === 'ingestion')!;
      const nodes = ingestion.output!.extractedNodes as Array<Record<string, unknown>>;
      const hub = nodes.find((n) => n.nodeRole === 'hub')!;
      expect(hub.keywords).toBe('docker 컨테이너 container devops');

      // Korean aliases
      const meta = hub.metadata as Record<string, unknown>;
      expect(meta.aliases).toContain('도커');
    });
  });

  // ── DetailPanel Full Data Construction ──

  describe('DetailPanel fullData construction from StageEntry', () => {
    /**
     * Mirrors the fullData construction in DetailPanel.tsx (lines 250-262).
     * This is what gets shown in the Raw JSON view.
     */
    function buildFullData(entry: StageEntry): Record<string, unknown> {
      return {
        stage: entry.stage,
        status: entry.status,
        isTopLevel: entry.isTopLevel,
        ...(entry.parentStage && { parentStage: entry.parentStage }),
        ...(entry.startedAt && { startedAt: entry.startedAt }),
        ...(entry.completedAt && { completedAt: entry.completedAt }),
        ...(entry.durationMs != null && { durationMs: entry.durationMs }),
        ...(entry.errorMessage && { errorMessage: entry.errorMessage }),
        ...(entry.skipReason && { skipReason: entry.skipReason }),
        ...(entry.input && { input: entry.input }),
        ...(entry.output && { output: entry.output }),
      };
    }

    it('constructs complete fullData for ingestion stage with MemoryNode details', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);
      const ingestion = stages.find((s) => s.stage === 'ingestion')!;

      const fullData = buildFullData(ingestion);

      expect(fullData.stage).toBe('ingestion');
      expect(fullData.status).toBe('done');
      expect(fullData.isTopLevel).toBe(true);
      expect(fullData.durationMs).toBe(200);
      expect(fullData.input).toBeDefined();
      expect(fullData.output).toBeDefined();
      expect(fullData.parentStage).toBeUndefined(); // Top-level, no parent

      // Output contains MemoryNode extraction results
      const output = fullData.output as Record<string, unknown>;
      expect(output.extractedNodeCount).toBe(2);
      expect(output.hubsLinked).toBe(1);
    });

    it('constructs fullData for error stage with errorMessage', () => {
      const traces = createErrorAndSkippedTraces();
      const stages = aggregateStages(traces);
      const vs = stages.find((s) => s.stage === 'vector_search')!;

      const fullData = buildFullData(vs);

      expect(fullData.stage).toBe('vector_search');
      expect(fullData.status).toBe('error');
      expect(fullData.errorMessage).toBe('Embedding model not loaded');
      expect(fullData.parentStage).toBe('recall');
      expect(fullData.isTopLevel).toBe(false);
    });

    it('constructs fullData for skipped stage with skipReason', () => {
      const traces = createErrorAndSkippedTraces();
      const stages = aggregateStages(traces);
      const gt = stages.find((s) => s.stage === 'graph_traversal')!;

      const fullData = buildFullData(gt);

      expect(fullData.stage).toBe('graph_traversal');
      expect(fullData.status).toBe('skipped');
      expect(fullData.skipReason).toBe('No seed nodes from failed vector search');
      expect(fullData.parentStage).toBe('recall');
    });

    it('serializes fullData to JSON without errors (for Raw JSON view)', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);

      for (const entry of stages) {
        const fullData = buildFullData(entry);
        // Must be JSON-serializable (used in <pre> + copy button)
        const json = JSON.stringify(fullData, null, 2);
        expect(json).toBeDefined();
        const parsed = JSON.parse(json);
        expect(parsed.stage).toBe(entry.stage);
      }
    });
  });

  // ── End-to-End Interaction Scenario ──

  describe('End-to-end interaction scenario', () => {
    it('simulates full user interaction: browse stages, inspect MemoryNodes, close', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);
      const stageMap = new Map(stages.map((s) => [s.stage, s]));

      let selectedStage: string | null = null;

      // Step 1: User clicks vector_search to see matched MemoryNodes
      selectedStage = toggleSelection(selectedStage, 'vector_search');
      let entry = resolveSelectedEntry(stageMap, selectedStage);
      expect(entry!.stage).toBe('vector_search');
      const matchedNodes = entry!.output!.matchedNodes as Array<Record<string, unknown>>;
      expect(matchedNodes[0].frontmatter).toBe('사용자는 TypeScript를 선호함');

      // Step 2: User switches to ingestion to see extracted MemoryNodes
      selectedStage = toggleSelection(selectedStage, 'ingestion');
      entry = resolveSelectedEntry(stageMap, selectedStage);
      expect(entry!.stage).toBe('ingestion');
      const extracted = entry!.output!.extractedNodes as Array<Record<string, unknown>>;
      expect(extracted).toHaveLength(2);
      expect(extracted[0].nodeType).toBe('semantic');
      expect(extracted[1].nodeType).toBe('episodic');

      // Step 3: User checks reinforce stage for shield/weight data
      selectedStage = toggleSelection(selectedStage, 'reinforce');
      entry = resolveSelectedEntry(stageMap, selectedStage);
      expect(entry!.output!.shieldGained).toBe(2);

      // Step 4: User checks format stage for progressive depth
      selectedStage = toggleSelection(selectedStage, 'format');
      entry = resolveSelectedEntry(stageMap, selectedStage);
      const depth = entry!.output!.progressiveDepth as Record<string, number>;
      expect(depth.L0_nodes).toBeGreaterThan(depth.L2_nodes);

      // Step 5: User closes detail panel
      selectedStage = toggleSelection(selectedStage, 'format');
      entry = resolveSelectedEntry(stageMap, selectedStage);
      expect(entry).toBeNull();
    });

    it('handles trace update: new traces replace old entries', () => {
      // First batch: partial pipeline (still running)
      const partialTraces: TraceEvent[] = [
        { stage: 'pipeline', status: 'start', timestamp: '2026-03-18T10:00:00Z' },
        { stage: 'recall', status: 'start', timestamp: '2026-03-18T10:00:00.010Z' },
        {
          stage: 'vector_search',
          status: 'start',
          timestamp: '2026-03-18T10:00:00.020Z',
          data: { queryText: '테스트 쿼리', searchMode: 'hybrid_fts_vector' },
        },
      ];

      let stages = aggregateStages(partialTraces);
      let stageMap = new Map(stages.map((s) => [s.stage, s]));

      // vector_search is running
      let vs = resolveSelectedEntry(stageMap, 'vector_search');
      expect(vs!.status).toBe('running');
      expect(vs!.input!.queryText).toBe('테스트 쿼리');
      expect(vs!.output).toBeUndefined();

      // Second batch: vector_search completes with MemoryNode results
      const fullTraces: TraceEvent[] = [
        ...partialTraces,
        {
          stage: 'vector_search',
          status: 'complete',
          durationMs: 50,
          timestamp: '2026-03-18T10:00:00.070Z',
          data: {
            matchedNodes: [
              { id: 'mn-100', nodeType: 'semantic', nodeRole: 'leaf', frontmatter: '테스트 결과' },
            ],
            totalNodeCount: 1,
          },
        },
      ];

      stages = aggregateStages(fullTraces);
      stageMap = new Map(stages.map((s) => [s.stage, s]));

      // Now vector_search is done with output
      vs = resolveSelectedEntry(stageMap, 'vector_search');
      expect(vs!.status).toBe('done');
      expect(vs!.durationMs).toBe(50);
      expect(vs!.output!.matchedNodes).toBeDefined();
      const nodes = vs!.output!.matchedNodes as Array<Record<string, unknown>>;
      expect(nodes[0].frontmatter).toBe('테스트 결과');

      // Input is still preserved from start event
      expect(vs!.input!.queryText).toBe('테스트 쿼리');
    });
  });

  // ── Multiple MemoryNode Types in Single Ingestion ──

  describe('Multiple MemoryNode types in single ingestion', () => {
    it('supports all 5 nodeTypes in a single extraction trace', () => {
      const traces: TraceEvent[] = [
        { stage: 'pipeline', status: 'start', timestamp: '2026-03-18T13:00:00Z' },
        {
          stage: 'ingestion',
          status: 'complete',
          durationMs: 300,
          timestamp: '2026-03-18T13:00:00.300Z',
          data: {
            extractedNodeCount: 5,
            extractedNodes: [
              { id: 'n1', nodeType: 'semantic', nodeRole: 'leaf', frontmatter: 'Fact: X is Y' },
              { id: 'n2', nodeType: 'episodic', nodeRole: 'leaf', frontmatter: 'Episode: user did Z' },
              { id: 'n3', nodeType: 'procedural', nodeRole: 'leaf', frontmatter: 'How to do W' },
              { id: 'n4', nodeType: 'prospective', nodeRole: 'leaf', frontmatter: '내일 할 일: V' },
              { id: 'n5', nodeType: 'emotional', nodeRole: 'leaf', frontmatter: '기분: 좋음' },
            ],
          },
        },
        { stage: 'pipeline', status: 'complete', durationMs: 300, timestamp: '2026-03-18T13:00:00.300Z' },
      ];

      const stages = aggregateStages(traces);
      const stageMap = new Map(stages.map((s) => [s.stage, s]));

      const ingestion = resolveSelectedEntry(stageMap, 'ingestion');
      expect(ingestion).not.toBeNull();

      const nodes = ingestion!.output!.extractedNodes as Array<Record<string, unknown>>;
      const types = nodes.map((n) => n.nodeType);
      expect(types).toEqual(['semantic', 'episodic', 'procedural', 'prospective', 'emotional']);
    });
  });

  // ── Graph Traversal with MemoryNode Edges ──

  describe('Graph traversal with MemoryNode edge data', () => {
    it('preserves traversed node details with mixed nodeTypes', () => {
      const traces = createMemoryNodePipelineTraces();
      const stages = aggregateStages(traces);
      const stageMap = new Map(stages.map((s) => [s.stage, s]));

      const gt = resolveSelectedEntry(stageMap, 'graph_traversal');
      expect(gt).not.toBeNull();

      // Input: seed nodes
      expect(gt!.input!.seedNodeIds).toEqual(['mn-002']);
      expect(gt!.input!.maxHops).toBe(2);

      // Output: traversed MemoryNodes
      const traversed = gt!.output!.traversedNodes as Array<Record<string, unknown>>;
      expect(traversed).toHaveLength(2);
      expect(traversed[0].nodeType).toBe('episodic');
      expect(traversed[1].nodeType).toBe('procedural');
      expect(gt!.output!.edgesTraversed).toBe(5);
    });
  });
});
