/**
 * Integration tests — Pipeline Trace Events (recall + ingestion)
 *
 * Verifies that all pipeline trace stages are emitted as event:trace SSE
 * messages with correct JSON payloads (stage name + raw data) when a
 * retriever is configured.
 *
 * The full pipeline emits 7 trace events:
 *   1. recall:start            — query text, userId
 *   2. recall:complete          — itemCount, full diagnostics (vector/graph/merge)
 *   3. format:start/complete    — context formatting (charCount, itemsIncluded)
 *   4. inject:start/complete    — prompt injection (finalPromptLength, messageCount)
 *   5. llm:start                — provider name, messageCount, hasMemoryContext
 *   6. llm:complete             — responseLength
 *   7. ingestion:skipped        — reason (when no factExtractor)
 *   8. pipeline:complete        — userId, responseLength, memoryItemCount, durationMs
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
import type { RecallResult, RecallDiagnostics } from '../src/retrieval/dual-path-retriever.js';

// ─── Mock LLM Provider ──────────────────────────────────

class MockStreamProvider implements LLMProvider {
  readonly name = 'test-provider';

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    return { content: `Echo: ${request.prompt}` };
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    yield { type: 'delta', content: 'Hello' };
    yield { type: 'delta', content: ' from' };
    yield { type: 'delta', content: ' memory' };
    yield {
      type: 'finish',
      content: 'Hello from memory',
      usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
    };
  }
}

// ─── Mock Retriever with rich diagnostics ────────────────

function createMockRetriever(overrides?: {
  items?: RecallResult['items'];
  diagnostics?: Partial<RecallDiagnostics>;
}): { recall: ReturnType<typeof vi.fn> } {
  const defaultDiagnostics: RecallDiagnostics = {
    activatedAnchors: [
      { anchorId: 'anchor-1', label: 'TypeScript', similarity: 0.92 },
      { anchorId: 'anchor-2', label: 'Programming', similarity: 0.78 },
    ],
    extractedEntities: ['TypeScript', 'generics', 'type system'],
    graphSeedCount: 3,
    vectorTimeMs: 14.5,
    graphTimeMs: 9.2,
    totalTimeMs: 18.7,
    vectorItemCount: 4,
    graphItemCount: 2,
    mergeStats: {
      totalBefore: 6,
      totalAfter: 3,
      duplicatesRemoved: 2,
      convergenceApplied: 1,
    },
    edgesReinforced: 2,
    vectorTimedOut: false,
    graphTimedOut: false,
    ...overrides?.diagnostics,
  };

  const defaultItems: RecallResult['items'] = overrides?.items ?? [
    {
      nodeId: 'fact-101',
      nodeType: 'fact',
      score: 0.91,
      content: 'User prefers TypeScript over JavaScript',
      sources: ['vector', 'graph'],
      sourceScores: { vector: 0.95, graph: 0.87 },
    } as any,
    {
      nodeId: 'concept-42',
      nodeType: 'concept',
      score: 0.73,
      content: 'Type safety in programming languages',
      sources: ['vector'],
      sourceScores: { vector: 0.73 },
    } as any,
    {
      nodeId: 'episode-7',
      nodeType: 'episode',
      score: 0.65,
      content: 'Discussion about generic type patterns',
      sources: ['graph'],
      sourceScores: { graph: 0.65 },
    } as any,
  ];

  const result: RecallResult = {
    items: defaultItems,
    diagnostics: defaultDiagnostics,
  };

  return {
    recall: vi.fn().mockResolvedValue(result),
  };
}

// ─── Helpers ─────────────────────────────────────────────

let provider: MockStreamProvider;

function makeDeps(overrides?: Partial<ChatRouterDependencies>): ChatRouterDependencies {
  return {
    llmProvider: provider,
    ...overrides,
  };
}

/** Expected trace stage sequence with retriever but no factExtractor.
 *  Note: format + inject replaced the old context-build stage for finer granularity. */
const EXPECTED_STAGES = [
  'recall:start',
  'recall:complete',
  'format:start',
  'format:complete',
  'inject:start',
  'inject:complete',
  'llm:start',
  'llm:complete',
  'ingestion:skipped',
  'pipeline:complete',
];

/** POST /chat and return parsed SSE events. */
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

/** Parse raw SSE text into structured events. */
function parseSSEStream(text: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split('\n');
    let event = '';
    let data = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        event = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        data = line.slice(6);
      }
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

/** Extract only event:trace SSE messages. */
function getTraceEvents(
  events: Array<{ event: string; data: unknown }>,
): TraceEvent[] {
  return events
    .filter((e) => e.event === 'trace')
    .map((e) => e.data as TraceEvent);
}

/** Find a specific trace event by stage + status. */
function findTrace(
  traces: TraceEvent[],
  stage: string,
  status: string,
): TraceEvent | undefined {
  return traces.find((t) => t.stage === stage && t.status === status);
}

// ─── Setup ──────────────────────────────────────────────

beforeEach(() => {
  provider = new MockStreamProvider();
});

// ─── Tests ──────────────────────────────────────────────

describe('Pipeline Trace Events — all stages with correct JSON payloads', () => {
  /**
   * Core test: all 7 trace events are emitted in the correct order.
   */
  it('emits all 7 trace events in correct order when retriever is configured', async () => {
    const retriever = createMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const events = await postChatAndParse({ message: 'Tell me about TypeScript' }, deps);
    const traces = getTraceEvents(events);

    const stages = traces.map((t) => `${t.stage}:${t.status}`);
    expect(stages).toEqual(EXPECTED_STAGES);
  });

  // ── Stage 1: recall:start ──

  describe('Stage 1 — recall:start', () => {
    it('contains stage "recall" with status "start"', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'recall', 'start')!;

      expect(trace).toBeDefined();
      expect(trace.stage).toBe('recall');
      expect(trace.status).toBe('start');
    });

    it('payload includes the query text and userId "debug-user"', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'TypeScript generics' }, deps);
      const trace = findTrace(getTraceEvents(events), 'recall', 'start')!;

      const data = trace.data as { query: string; userId: string };
      expect(data.query).toBe('TypeScript generics');
      expect(data.userId).toBe('debug-user');
    });

    it('has a valid ISO 8601 timestamp', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'test' }, deps);
      const trace = findTrace(getTraceEvents(events), 'recall', 'start')!;

      expect(trace.timestamp).toBeDefined();
      expect(new Date(trace.timestamp).toISOString()).toBe(trace.timestamp);
    });

    it('does not include durationMs (start event only)', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'test' }, deps);
      const trace = findTrace(getTraceEvents(events), 'recall', 'start')!;

      expect(trace.durationMs).toBeUndefined();
    });
  });

  // ── Stage 2: recall:complete ──

  describe('Stage 2 — recall:complete', () => {
    it('contains stage "recall" with status "complete"', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'recall', 'complete')!;

      expect(trace).toBeDefined();
      expect(trace.stage).toBe('recall');
      expect(trace.status).toBe('complete');
    });

    it('payload includes itemCount matching retrieved items', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'recall', 'complete')!;

      const data = trace.data as { itemCount: number; diagnostics: unknown };
      expect(data.itemCount).toBe(3); // 3 items from mock retriever
    });

    it('payload includes full diagnostics with vector/graph/merge data', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'recall', 'complete')!;

      const data = trace.data as { itemCount: number; diagnostics: RecallDiagnostics };
      const diag = data.diagnostics;

      // Vector path diagnostics
      expect(diag.vectorTimeMs).toBe(14.5);
      expect(diag.vectorItemCount).toBe(4);
      expect(diag.vectorTimedOut).toBe(false);
      expect(diag.activatedAnchors).toHaveLength(2);
      expect(diag.activatedAnchors[0].label).toBe('TypeScript');

      // Graph path diagnostics
      expect(diag.graphTimeMs).toBe(9.2);
      expect(diag.graphItemCount).toBe(2);
      expect(diag.graphTimedOut).toBe(false);
      expect(diag.extractedEntities).toEqual(['TypeScript', 'generics', 'type system']);
      expect(diag.graphSeedCount).toBe(3);

      // Merge diagnostics
      expect(diag.mergeStats.totalBefore).toBe(6);
      expect(diag.mergeStats.totalAfter).toBe(3);
      expect(diag.mergeStats.duplicatesRemoved).toBe(2);
      expect(diag.mergeStats.convergenceApplied).toBe(1);

      // Hebbian reinforcement
      expect(diag.edgesReinforced).toBe(2);
    });

    it('has durationMs >= 0', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'recall', 'complete')!;

      expect(trace.durationMs).toBeDefined();
      expect(typeof trace.durationMs).toBe('number');
      expect(trace.durationMs!).toBeGreaterThanOrEqual(0);
    });

    it('reflects empty recall results correctly', async () => {
      const retriever = createMockRetriever({ items: [] });
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'recall', 'complete')!;

      const data = trace.data as { itemCount: number; diagnostics: RecallDiagnostics };
      expect(data.itemCount).toBe(0);
    });
  });

  // ── Stage 3-4: format + inject (replaced context-build) ──

  describe('Stages 3-4 — format + inject (context building)', () => {
    it('emits format:start, format:complete, inject:start, inject:complete', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const traces = getTraceEvents(events);

      expect(findTrace(traces, 'format', 'start')).toBeDefined();
      expect(findTrace(traces, 'format', 'complete')).toBeDefined();
      expect(findTrace(traces, 'inject', 'start')).toBeDefined();
      expect(findTrace(traces, 'inject', 'complete')).toBeDefined();
    });

    it('inject:complete payload includes hasMemoryContext=true when recall returns items', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'inject', 'complete')!;

      const data = trace.data as { hasMemoryContext: boolean; finalPromptLength: number; messageCount: number };
      expect(data.hasMemoryContext).toBe(true);
      expect(data.finalPromptLength).toBeGreaterThan(0);
    });

    it('inject:complete payload includes hasMemoryContext=false when recall returns no items', async () => {
      const retriever = createMockRetriever({ items: [] });
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'inject', 'complete')!;

      const data = trace.data as { hasMemoryContext: boolean };
      expect(data.hasMemoryContext).toBe(false);
    });

    it('inject:complete payload includes messageCount', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse(
        {
          message: 'hello',
          history: [
            { role: 'user', content: 'prev' },
            { role: 'assistant', content: 'reply' },
          ],
        },
        deps,
      );
      const trace = findTrace(getTraceEvents(events), 'inject', 'complete')!;

      const data = trace.data as { messageCount: number; finalPromptLength: number };
      expect(data.messageCount).toBe(3); // 2 history + 1 current
      expect(data.finalPromptLength).toBeGreaterThan(0);
    });

    it('inject:complete has durationMs >= 0', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'inject', 'complete')!;

      expect(trace.durationMs).toBeDefined();
      expect(typeof trace.durationMs).toBe('number');
      expect(trace.durationMs!).toBeGreaterThanOrEqual(0);
    });

    it('has valid ISO 8601 timestamps', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'test' }, deps);
      const formatTrace = findTrace(getTraceEvents(events), 'format', 'complete')!;
      const injectTrace = findTrace(getTraceEvents(events), 'inject', 'complete')!;

      expect(new Date(formatTrace.timestamp).toISOString()).toBe(formatTrace.timestamp);
      expect(new Date(injectTrace.timestamp).toISOString()).toBe(injectTrace.timestamp);
    });
  });

  // ── Stage 4: llm:start ──

  describe('Stage 4 — llm:start', () => {
    it('contains stage "llm" with status "start"', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'llm', 'start')!;

      expect(trace).toBeDefined();
      expect(trace.stage).toBe('llm');
      expect(trace.status).toBe('start');
    });

    it('payload includes provider name from LLMProvider', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'llm', 'start')!;

      const data = trace.data as { provider: string };
      expect(data.provider).toBe('test-provider');
    });

    it('payload includes correct messageCount (history + current)', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });

      const events = await postChatAndParse(
        {
          message: 'current question',
          history: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'response' },
          ],
        },
        deps,
      );
      const trace = findTrace(getTraceEvents(events), 'llm', 'start')!;
      const data = trace.data as { messageCount: number };
      expect(data.messageCount).toBe(3);
    });

    it('payload shows hasMemoryContext=true when recall returns items', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'llm', 'start')!;

      const data = trace.data as { hasMemoryContext: boolean };
      expect(data.hasMemoryContext).toBe(true);
    });

    it('payload shows hasMemoryContext=false when recall returns no items', async () => {
      const retriever = createMockRetriever({ items: [] });
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'llm', 'start')!;

      const data = trace.data as { hasMemoryContext: boolean };
      expect(data.hasMemoryContext).toBe(false);
    });

    it('has a valid ISO 8601 timestamp', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'test' }, deps);
      const trace = findTrace(getTraceEvents(events), 'llm', 'start')!;

      expect(new Date(trace.timestamp).toISOString()).toBe(trace.timestamp);
    });
  });

  // ── Stage 5: llm:complete ──

  describe('Stage 5 — llm:complete', () => {
    it('contains stage "llm" with status "complete"', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'llm', 'complete')!;

      expect(trace).toBeDefined();
      expect(trace.stage).toBe('llm');
      expect(trace.status).toBe('complete');
    });

    it('payload includes responseLength matching streamed content', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'llm', 'complete')!;

      const data = trace.data as { responseLength: number };
      // "Hello from memory" = 17 chars
      expect(data.responseLength).toBe(17);
    });

    it('has durationMs >= 0', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'llm', 'complete')!;

      expect(trace.durationMs).toBeDefined();
      expect(typeof trace.durationMs).toBe('number');
      expect(trace.durationMs!).toBeGreaterThanOrEqual(0);
    });

    it('has a valid ISO 8601 timestamp', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'test' }, deps);
      const trace = findTrace(getTraceEvents(events), 'llm', 'complete')!;

      expect(new Date(trace.timestamp).toISOString()).toBe(trace.timestamp);
    });
  });

  // ── Stage 6: ingestion:skipped ──

  describe('Stage 6 — ingestion:skipped (no factExtractor)', () => {
    it('contains stage "ingestion" with status "skipped"', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'ingestion', 'skipped')!;

      expect(trace).toBeDefined();
      expect(trace.stage).toBe('ingestion');
      expect(trace.status).toBe('skipped');
    });

    it('payload includes reason explaining why ingestion was skipped', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'ingestion', 'skipped')!;

      const data = trace.data as { reason: string };
      expect(data.reason).toBeDefined();
      expect(typeof data.reason).toBe('string');
      expect(data.reason.length).toBeGreaterThan(0);
    });

    it('has a valid ISO 8601 timestamp', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'test' }, deps);
      const trace = findTrace(getTraceEvents(events), 'ingestion', 'skipped')!;

      expect(new Date(trace.timestamp).toISOString()).toBe(trace.timestamp);
    });
  });

  // ── Stage 7: pipeline:complete ──

  describe('Stage 7 — pipeline:complete', () => {
    it('contains stage "pipeline" with status "complete"', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'pipeline', 'complete')!;

      expect(trace).toBeDefined();
      expect(trace.stage).toBe('pipeline');
      expect(trace.status).toBe('complete');
    });

    it('payload includes userId "debug-user"', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'pipeline', 'complete')!;

      const data = trace.data as { userId: string };
      expect(data.userId).toBe('debug-user');
    });

    it('payload includes responseLength matching LLM output', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'pipeline', 'complete')!;

      const data = trace.data as { responseLength: number };
      expect(data.responseLength).toBe(17); // "Hello from memory"
    });

    it('payload includes memoryItemCount matching recall results', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'pipeline', 'complete')!;

      const data = trace.data as { memoryItemCount: number };
      expect(data.memoryItemCount).toBe(3);
    });

    it('memoryItemCount is 0 when recall returns empty', async () => {
      const retriever = createMockRetriever({ items: [] });
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'pipeline', 'complete')!;

      const data = trace.data as { memoryItemCount: number };
      expect(data.memoryItemCount).toBe(0);
    });

    it('has durationMs >= 0 representing total pipeline time', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const trace = findTrace(getTraceEvents(events), 'pipeline', 'complete')!;

      expect(trace.durationMs).toBeDefined();
      expect(typeof trace.durationMs).toBe('number');
      expect(trace.durationMs!).toBeGreaterThanOrEqual(0);
    });

    it('has a valid ISO 8601 timestamp', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'test' }, deps);
      const trace = findTrace(getTraceEvents(events), 'pipeline', 'complete')!;

      expect(new Date(trace.timestamp).toISOString()).toBe(trace.timestamp);
    });

    it('is the second-to-last event (before done)', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);

      const lastTwo = events.slice(-2);
      expect(lastTwo[0].event).toBe('trace');
      expect((lastTwo[0].data as TraceEvent).stage).toBe('pipeline');
      expect((lastTwo[0].data as TraceEvent).status).toBe('complete');
      expect(lastTwo[1].event).toBe('done');
    });
  });

  // ── Cross-stage validation ──

  describe('Cross-stage validation', () => {
    it('all trace events have valid JSON payloads that can be round-tripped', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const traces = getTraceEvents(events);

      expect(traces.length).toBe(EXPECTED_STAGES.length);

      for (const trace of traces) {
        const json = JSON.stringify(trace);
        const parsed = JSON.parse(json) as TraceEvent;
        expect(parsed.stage).toBe(trace.stage);
        expect(parsed.status).toBe(trace.status);
        expect(parsed.timestamp).toBe(trace.timestamp);
      }
    });

    it('timestamps are monotonically non-decreasing across all stages', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const traces = getTraceEvents(events);

      for (let i = 1; i < traces.length; i++) {
        const prev = new Date(traces[i - 1].timestamp).getTime();
        const curr = new Date(traces[i].timestamp).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });

    it('pipeline durationMs >= recall durationMs + llm durationMs', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const traces = getTraceEvents(events);

      const recallDuration = findTrace(traces, 'recall', 'complete')!.durationMs!;
      const llmDuration = findTrace(traces, 'llm', 'complete')!.durationMs!;
      const pipelineDuration = findTrace(traces, 'pipeline', 'complete')!.durationMs!;

      expect(pipelineDuration).toBeGreaterThanOrEqual(recallDuration + llmDuration - 1);
    });

    it('event ordering: recall → format → inject → llm → ingestion → pipeline', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);

      const traceIndices: Record<string, number> = {};
      events.forEach((e, i) => {
        if (e.event === 'trace') {
          const t = e.data as TraceEvent;
          const key = `${t.stage}:${t.status}`;
          traceIndices[key] = i;
        }
      });

      expect(traceIndices['recall:start']).toBeLessThan(traceIndices['recall:complete']);
      expect(traceIndices['recall:complete']).toBeLessThan(traceIndices['format:start']);
      expect(traceIndices['format:complete']).toBeLessThan(traceIndices['inject:start']);
      expect(traceIndices['inject:complete']).toBeLessThan(traceIndices['llm:start']);
      expect(traceIndices['llm:start']).toBeLessThan(traceIndices['llm:complete']);
      expect(traceIndices['llm:complete']).toBeLessThan(traceIndices['ingestion:skipped']);
      expect(traceIndices['ingestion:skipped']).toBeLessThan(traceIndices['pipeline:complete']);
    });

    it('every trace has a non-empty stage and valid status', async () => {
      const retriever = createMockRetriever();
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const traces = getTraceEvents(events);

      for (const trace of traces) {
        expect(trace.stage).toBeDefined();
        expect(typeof trace.stage).toBe('string');
        expect(trace.stage.length).toBeGreaterThan(0);
        expect(['start', 'complete', 'error', 'skipped']).toContain(trace.status);
      }
    });
  });

  // ── Error path: recall error ──

  describe('Error path — recall failure', () => {
    it('emits recall:error instead of recall:complete', async () => {
      const retriever = {
        recall: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      };
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const traces = getTraceEvents(events);

      const stages = traces.map((t) => `${t.stage}:${t.status}`);
      expect(stages).toEqual([
        'recall:start',
        'recall:error',
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

    it('recall:error trace includes the error message in data', async () => {
      const retriever = {
        recall: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      };
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const traces = getTraceEvents(events);

      const recallError = findTrace(traces, 'recall', 'error')!;
      expect(recallError.durationMs).toBeGreaterThanOrEqual(0);
      const data = recallError.data as { error: string };
      expect(data.error).toBe('DB connection lost');
    });

    it('llm:start shows hasMemoryContext=false after recall error', async () => {
      const retriever = {
        recall: vi.fn().mockRejectedValue(new Error('DB error')),
      };
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const traces = getTraceEvents(events);

      const llmStart = findTrace(traces, 'llm', 'start')!;
      const data = llmStart.data as { hasMemoryContext: boolean };
      expect(data.hasMemoryContext).toBe(false);
    });

    it('pipeline:complete shows memoryItemCount=0 after recall error', async () => {
      const retriever = {
        recall: vi.fn().mockRejectedValue(new Error('DB error')),
      };
      const deps = makeDeps({ retriever: retriever as any });
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const traces = getTraceEvents(events);

      const pipelineComplete = findTrace(traces, 'pipeline', 'complete')!;
      const data = pipelineComplete.data as { memoryItemCount: number };
      expect(data.memoryItemCount).toBe(0);
    });
  });

  // ── Error path: LLM error ──

  describe('Error path — LLM stream failure', () => {
    it('emits llm:error instead of llm:complete', async () => {
      const errorProvider: LLMProvider = {
        name: 'error-provider',
        complete: async () => ({ content: '' }),
        async *stream() {
          throw new Error('API key expired');
        },
      };
      const retriever = createMockRetriever();
      const deps: ChatRouterDependencies = {
        llmProvider: errorProvider,
        retriever: retriever as any,
      };
      const events = await postChatAndParse({ message: 'hello' }, deps);
      const traces = getTraceEvents(events);

      const stages = traces.map((t) => `${t.stage}:${t.status}`);
      expect(stages).toEqual([
        'recall:start',
        'recall:complete',
        'format:start',
        'format:complete',
        'inject:start',
        'inject:complete',
        'llm:start',
        'llm:error',
        'ingestion:skipped',
        'pipeline:complete',
      ]);

      const llmError = findTrace(traces, 'llm', 'error')!;
      expect(llmError.durationMs).toBeGreaterThanOrEqual(0);
      const data = llmError.data as { error: string };
      expect(data.error).toBe('API key expired');
    });
  });
});
