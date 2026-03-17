/**
 * Tests — Recall sub-stage trace events streamed as SSE event:trace
 *
 * Validates Sub-AC 3: The chat SSE endpoint receives recall trace events
 * from the DualPathRetriever's traceHook and streams them as event:trace
 * SSE messages with the correct stage names, statuses, and payloads.
 *
 * The recall pipeline emits these sub-stage events (between recall:start
 * and recall:complete):
 *   - vector_search:start/complete
 *   - graph_traversal:start/complete
 *   - merge:start/complete
 *   - reinforce:complete|skipped
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createChatRouter,
  type TraceEvent,
  type ChatRouterDependencies,
} from '../src/chat/chat-router.js';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamRequest,
  LLMStreamEvent,
} from '../src/extraction/llm-provider.js';
import type {
  RecallResult,
  RecallDiagnostics,
  RecallQuery,
  RecallTraceHook,
  RecallTraceEvent,
} from '../src/retrieval/dual-path-retriever.js';

// ─── Mock LLM Provider ──────────────────────────────────

class MockStreamProvider implements LLMProvider {
  readonly name = 'test-provider';

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    return { content: `Echo: ${request.prompt}` };
  }

  async *stream(_request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    yield { type: 'delta', content: 'Hello' };
    yield { type: 'finish', content: 'Hello', usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } };
  }
}

// ─── Mock Retriever that emits traceHook events ──────────

/**
 * Creates a mock retriever that:
 *   1. Calls the traceHook for each sub-stage (simulating DualPathRetriever behavior)
 *   2. Returns the given recall result
 */
function createTracingMockRetriever(options?: {
  items?: RecallResult['items'];
  diagnostics?: Partial<RecallDiagnostics>;
  emitSubStages?: boolean;
}): { recall: ReturnType<typeof vi.fn> } {
  const emitSubStages = options?.emitSubStages ?? true;

  const defaultDiagnostics: RecallDiagnostics = {
    activatedAnchors: [
      { anchorId: 'anchor-1', label: 'TypeScript', similarity: 0.92 },
    ],
    extractedEntities: ['TypeScript'],
    graphSeedCount: 1,
    vectorTimeMs: 10,
    graphTimeMs: 8,
    totalTimeMs: 15,
    vectorItemCount: 2,
    graphItemCount: 1,
    mergeStats: {
      vectorInputCount: 2,
      graphInputCount: 1,
      overlapCount: 0,
      uniqueCount: 3,
      filteredCount: 0,
      outputCount: 2,
      mergeTimeMs: 0.5,
    },
    edgesReinforced: 0,
    vectorTimedOut: false,
    graphTimedOut: false,
    ...options?.diagnostics,
  };

  const defaultItems: RecallResult['items'] = options?.items ?? [
    {
      nodeId: 'fact-1',
      nodeType: 'fact',
      score: 0.9,
      content: 'User prefers TypeScript',
      sources: ['vector'],
      sourceScores: { vector: 0.9 },
    } as any,
    {
      nodeId: 'concept-1',
      nodeType: 'concept',
      score: 0.7,
      content: 'Type safety',
      sources: ['graph'],
      sourceScores: { graph: 0.7 },
    } as any,
  ];

  const recallFn = vi.fn().mockImplementation(async (query: RecallQuery) => {
    const hook = query.traceHook;

    if (emitSubStages && hook) {
      // Simulate vector_search
      hook({
        stage: 'vector_search',
        status: 'start',
        input: { queryText: query.queryText, topK: 10 },
        timestamp: new Date().toISOString(),
      });
      hook({
        stage: 'vector_search',
        status: 'complete',
        durationMs: 10,
        output: {
          matchedAnchors: defaultDiagnostics.activatedAnchors,
          itemCount: defaultDiagnostics.vectorItemCount,
          timedOut: false,
        },
        timestamp: new Date().toISOString(),
      });

      // Simulate graph_traversal
      hook({
        stage: 'graph_traversal',
        status: 'start',
        input: { queryText: query.queryText, maxHops: 2 },
        timestamp: new Date().toISOString(),
      });
      hook({
        stage: 'graph_traversal',
        status: 'complete',
        durationMs: 8,
        output: {
          extractedEntities: defaultDiagnostics.extractedEntities,
          seedCount: defaultDiagnostics.graphSeedCount,
          itemCount: defaultDiagnostics.graphItemCount,
          timedOut: false,
        },
        timestamp: new Date().toISOString(),
      });

      // Simulate merge
      hook({
        stage: 'merge',
        status: 'start',
        input: { vectorItemCount: 2, graphItemCount: 1 },
        timestamp: new Date().toISOString(),
      });
      hook({
        stage: 'merge',
        status: 'complete',
        durationMs: 0.5,
        output: {
          mergedItemCount: 2,
          stats: defaultDiagnostics.mergeStats,
        },
        timestamp: new Date().toISOString(),
      });

      // Simulate reinforce (skipped — no activated anchors for simplicity)
      hook({
        stage: 'reinforce',
        status: 'skipped',
        skipReason: 'No activated anchors',
        timestamp: new Date().toISOString(),
      });
    }

    return {
      items: defaultItems,
      diagnostics: defaultDiagnostics,
    } as RecallResult;
  });

  return { recall: recallFn };
}

// ─── Helpers ──────────────────────────────────────────────

let provider: MockStreamProvider;

function makeDeps(overrides?: Partial<ChatRouterDependencies>): ChatRouterDependencies {
  return { llmProvider: provider, ...overrides };
}

async function postChatAndParse(
  body: Record<string, unknown>,
  deps: ChatRouterDependencies,
): Promise<Array<{ event: string; data: unknown }>> {
  const app = createChatRouter(deps);
  const response = await app.request('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('text/event-stream');

  const text = await response.text();
  return parseSSEStream(text);
}

function parseSSEStream(text: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split('\n');
    let event = '';
    let data = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data = line.slice(6);
    }

    if (event && data) {
      try {
        events.push({ event, data: JSON.parse(data) });
      } catch {
        events.push({ event, data });
      }
    }
  }

  return events;
}

function getTraceEvents(events: Array<{ event: string; data: unknown }>): TraceEvent[] {
  return events.filter((e) => e.event === 'trace').map((e) => e.data as TraceEvent);
}

function findTrace(traces: TraceEvent[], stage: string, status: string): TraceEvent | undefined {
  return traces.find((t) => t.stage === stage && t.status === status);
}

// ─── Setup ───────────────────────────────────────────────

beforeEach(() => {
  provider = new MockStreamProvider();
});

// ─── Tests ───────────────────────────────────────────────

describe('Recall sub-stage trace events streamed via SSE', () => {
  it('streams vector_search:start and vector_search:complete as event:trace', async () => {
    const retriever = createTracingMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const events = await postChatAndParse({ message: 'TypeScript tips' }, deps);
    const traces = getTraceEvents(events);

    const vsStart = findTrace(traces, 'vector_search', 'start');
    const vsComplete = findTrace(traces, 'vector_search', 'complete');

    expect(vsStart).toBeDefined();
    expect(vsComplete).toBeDefined();
    expect(vsComplete!.durationMs).toBe(10);

    // Check payload structure
    const startData = vsStart!.data as Record<string, unknown>;
    expect(startData.input).toBeDefined();
    expect((startData.input as any).queryText).toBe('TypeScript tips');

    const completeData = vsComplete!.data as Record<string, unknown>;
    expect(completeData.output).toBeDefined();
    expect((completeData.output as any).itemCount).toBe(2);
  });

  it('streams graph_traversal:start and graph_traversal:complete as event:trace', async () => {
    const retriever = createTracingMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const events = await postChatAndParse({ message: 'TypeScript tips' }, deps);
    const traces = getTraceEvents(events);

    const gtStart = findTrace(traces, 'graph_traversal', 'start');
    const gtComplete = findTrace(traces, 'graph_traversal', 'complete');

    expect(gtStart).toBeDefined();
    expect(gtComplete).toBeDefined();
    expect(gtComplete!.durationMs).toBe(8);

    const completeData = gtComplete!.data as Record<string, unknown>;
    expect(completeData.output).toBeDefined();
    expect((completeData.output as any).extractedEntities).toContain('TypeScript');
  });

  it('streams merge:start and merge:complete as event:trace', async () => {
    const retriever = createTracingMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const events = await postChatAndParse({ message: 'hello' }, deps);
    const traces = getTraceEvents(events);

    const mergeStart = findTrace(traces, 'merge', 'start');
    const mergeComplete = findTrace(traces, 'merge', 'complete');

    expect(mergeStart).toBeDefined();
    expect(mergeComplete).toBeDefined();
    expect(mergeComplete!.durationMs).toBe(0.5);

    const startData = mergeStart!.data as Record<string, unknown>;
    expect(startData.input).toBeDefined();
    expect((startData.input as any).vectorItemCount).toBe(2);
    expect((startData.input as any).graphItemCount).toBe(1);

    const completeData = mergeComplete!.data as Record<string, unknown>;
    expect(completeData.output).toBeDefined();
    expect((completeData.output as any).mergedItemCount).toBe(2);
  });

  it('streams reinforce:skipped as event:trace', async () => {
    const retriever = createTracingMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const events = await postChatAndParse({ message: 'hello' }, deps);
    const traces = getTraceEvents(events);

    const reinforceSkipped = findTrace(traces, 'reinforce', 'skipped');
    expect(reinforceSkipped).toBeDefined();

    const data = reinforceSkipped!.data as Record<string, unknown>;
    expect(data.reason).toBe('No activated anchors');
  });

  it('sub-stage events appear between recall:start and recall:complete', async () => {
    const retriever = createTracingMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const events = await postChatAndParse({ message: 'hello' }, deps);
    const traces = getTraceEvents(events);

    const stageSequence = traces.map((t) => `${t.stage}:${t.status}`);
    const recallStartIdx = stageSequence.indexOf('recall:start');
    const recallCompleteIdx = stageSequence.indexOf('recall:complete');

    // All sub-stages should be between recall:start and recall:complete
    const vectorSearchIdx = stageSequence.indexOf('vector_search:start');
    const graphTraversalIdx = stageSequence.indexOf('graph_traversal:start');
    const mergeIdx = stageSequence.indexOf('merge:start');
    const reinforceIdx = stageSequence.indexOf('reinforce:skipped');

    expect(vectorSearchIdx).toBeGreaterThan(recallStartIdx);
    expect(vectorSearchIdx).toBeLessThan(recallCompleteIdx);
    expect(graphTraversalIdx).toBeGreaterThan(recallStartIdx);
    expect(graphTraversalIdx).toBeLessThan(recallCompleteIdx);
    expect(mergeIdx).toBeGreaterThan(recallStartIdx);
    expect(mergeIdx).toBeLessThan(recallCompleteIdx);
    expect(reinforceIdx).toBeGreaterThan(recallStartIdx);
    expect(reinforceIdx).toBeLessThan(recallCompleteIdx);
  });

  it('complete trace event sequence includes sub-stages', async () => {
    const retriever = createTracingMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const events = await postChatAndParse({ message: 'hello' }, deps);
    const traces = getTraceEvents(events);

    const stageSequence = traces.map((t) => `${t.stage}:${t.status}`);

    // Expected full sequence with sub-stages
    expect(stageSequence).toEqual([
      'recall:start',
      'vector_search:start',
      'vector_search:complete',
      'graph_traversal:start',
      'graph_traversal:complete',
      'merge:start',
      'merge:complete',
      'reinforce:skipped',
      'recall:complete',
      'format:start',
      'format:complete',
      'inject:start',
      'inject:complete',
      'llm:start',
      'llm:complete',
      'ingestion:skipped',
      'pipeline:complete',
    ]);
  });

  it('all sub-stage events have valid ISO 8601 timestamps', async () => {
    const retriever = createTracingMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const events = await postChatAndParse({ message: 'hello' }, deps);
    const traces = getTraceEvents(events);

    const subStages = traces.filter((t) =>
      ['vector_search', 'graph_traversal', 'merge', 'reinforce'].includes(t.stage),
    );

    expect(subStages.length).toBe(7); // 2 + 2 + 2 + 1

    for (const trace of subStages) {
      expect(trace.timestamp).toBeDefined();
      expect(new Date(trace.timestamp).toISOString()).toBe(trace.timestamp);
    }
  });

  it('sub-stage events are included in the DoneEvent traceEvents array', async () => {
    const retriever = createTracingMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const events = await postChatAndParse({ message: 'hello' }, deps);
    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent).toBeDefined();

    const doneData = doneEvent!.data as { traceEvents: TraceEvent[] };
    const subStageEvents = doneData.traceEvents.filter((t) =>
      ['vector_search', 'graph_traversal', 'merge', 'reinforce'].includes(t.stage),
    );

    expect(subStageEvents.length).toBe(7);
  });

  it('no sub-stage events when retriever is not configured', async () => {
    const deps = makeDeps(); // no retriever

    const events = await postChatAndParse({ message: 'hello' }, deps);
    const traces = getTraceEvents(events);

    const subStages = traces.filter((t) =>
      ['vector_search', 'graph_traversal', 'merge', 'reinforce'].includes(t.stage),
    );

    expect(subStages.length).toBe(0);
  });

  it('no sub-stage events when retriever does not call traceHook', async () => {
    const retriever = createTracingMockRetriever({ emitSubStages: false });
    const deps = makeDeps({ retriever: retriever as any });

    const events = await postChatAndParse({ message: 'hello' }, deps);
    const traces = getTraceEvents(events);

    const subStages = traces.filter((t) =>
      ['vector_search', 'graph_traversal', 'merge', 'reinforce'].includes(t.stage),
    );

    expect(subStages.length).toBe(0);
  });

  it('traceHook is passed to retriever.recall()', async () => {
    const retriever = createTracingMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    await postChatAndParse({ message: 'hello' }, deps);

    expect(retriever.recall).toHaveBeenCalledTimes(1);
    const callArgs = retriever.recall.mock.calls[0][0] as RecallQuery;
    expect(callArgs.queryText).toBe('hello');
    expect(typeof callArgs.traceHook).toBe('function');
  });

  it('sub-stage error events are streamed correctly', async () => {
    const retriever = {
      recall: vi.fn().mockImplementation(async (query: RecallQuery) => {
        const hook = query.traceHook;

        hook?.({
          stage: 'vector_search',
          status: 'start',
          input: { queryText: query.queryText },
          timestamp: new Date().toISOString(),
        });
        hook?.({
          stage: 'vector_search',
          status: 'error',
          error: 'Embedding API unavailable',
          durationMs: 50,
          timestamp: new Date().toISOString(),
        });

        hook?.({
          stage: 'graph_traversal',
          status: 'start',
          input: { queryText: query.queryText },
          timestamp: new Date().toISOString(),
        });
        hook?.({
          stage: 'graph_traversal',
          status: 'complete',
          durationMs: 5,
          output: { extractedEntities: [], seedCount: 0, itemCount: 0, timedOut: false },
          timestamp: new Date().toISOString(),
        });

        hook?.({
          stage: 'merge',
          status: 'start',
          input: { vectorItemCount: 0, graphItemCount: 0 },
          timestamp: new Date().toISOString(),
        });
        hook?.({
          stage: 'merge',
          status: 'complete',
          durationMs: 0.1,
          output: { mergedItemCount: 0 },
          timestamp: new Date().toISOString(),
        });

        hook?.({
          stage: 'reinforce',
          status: 'skipped',
          skipReason: 'No merged items',
          timestamp: new Date().toISOString(),
        });

        return {
          items: [],
          diagnostics: {
            activatedAnchors: [],
            extractedEntities: [],
            graphSeedCount: 0,
            vectorTimeMs: 0,
            graphTimeMs: 5,
            totalTimeMs: 55,
            vectorItemCount: 0,
            graphItemCount: 0,
            mergeStats: {
              vectorInputCount: 0,
              graphInputCount: 0,
              overlapCount: 0,
              uniqueCount: 0,
              filteredCount: 0,
              outputCount: 0,
              mergeTimeMs: 0.1,
            },
            edgesReinforced: 0,
            vectorTimedOut: false,
            graphTimedOut: false,
          },
        } as RecallResult;
      }),
    };

    const deps = makeDeps({ retriever: retriever as any });
    const events = await postChatAndParse({ message: 'test' }, deps);
    const traces = getTraceEvents(events);

    const vsError = findTrace(traces, 'vector_search', 'error');
    expect(vsError).toBeDefined();
    expect(vsError!.durationMs).toBe(50);
    const errorData = vsError!.data as Record<string, unknown>;
    expect(errorData.error).toBe('Embedding API unavailable');
  });
});
