/**
 * Tests for TraceEvent SSE serialization, TraceCollector, and pipeline tracing.
 *
 * Validates:
 * - TraceCollector collects and summarizes events correctly
 * - safeSerialize handles edge cases (circular refs, BigInt, oversized payloads)
 * - formatSSE uses safe serialization
 * - format + inject trace stages are emitted (replaced context-build)
 * - ingestion trace stage is emitted (skipped when no handler)
 * - DoneEvent includes collected traceEvents array
 * - Full pipeline trace event ordering with all stages
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createChatRouter,
  formatSSE,
  safeSerialize,
  TraceCollector,
  type TraceEvent,
  type ChatEvent,
  type DoneEvent,
  type ChatRouterDependencies,
  type IngestionHandler,
} from '../src/chat/chat-router.js';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamRequest,
  LLMStreamEvent,
} from '../src/extraction/llm-provider.js';
import type { RecallResult } from '../src/retrieval/dual-path-retriever.js';

// ─── Mock Providers ───────────────────────────────────────

class MockStreamingProvider implements LLMProvider {
  readonly name = 'mock-streaming';
  public streamCalls: LLMStreamRequest[] = [];

  public queuedEvents: LLMStreamEvent[] = [
    { type: 'delta', content: 'Hello' },
    { type: 'delta', content: ' world' },
    { type: 'finish', content: 'Hello world', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
  ];

  public streamError: Error | null = null;

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    return { content: 'complete response' };
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    this.streamCalls.push(request);
    if (this.streamError) throw this.streamError;
    for (const event of this.queuedEvents) yield event;
  }
}

// ─── Mock Retriever ───────────────────────────────────────

function createMockRetriever(result?: Partial<RecallResult>) {
  const defaultResult: RecallResult = {
    items: [
      {
        nodeId: 'fact-1',
        nodeType: 'fact',
        score: 0.85,
        content: 'User likes TypeScript',
        sources: ['vector'],
        sourceScores: { vector: 0.85 },
      } as any,
    ],
    diagnostics: {
      activatedAnchors: [],
      extractedEntities: ['TypeScript'],
      graphSeedCount: 0,
      vectorTimeMs: 10,
      graphTimeMs: 5,
      totalTimeMs: 12,
      vectorItemCount: 1,
      graphItemCount: 0,
      mergeStats: { totalBefore: 1, totalAfter: 1, duplicatesRemoved: 0, convergenceApplied: 0 },
      edgesReinforced: 0,
      vectorTimedOut: false,
      graphTimedOut: false,
    },
    ...result,
  };
  return { recall: vi.fn().mockResolvedValue(defaultResult) };
}

// ─── Mock Ingestion Handler ───────────────────────────────

function createMockIngestionHandler(result?: Partial<ReturnType<IngestionHandler['ingest']> extends Promise<infer R> ? R : never>): IngestionHandler {
  return {
    ingest: vi.fn().mockResolvedValue({
      factCount: 2,
      facts: [{ content: 'User prefers dark mode' }, { content: 'User works with TypeScript' }],
      ...result,
    }),
  };
}

function createErrorIngestionHandler(): IngestionHandler {
  return {
    ingest: vi.fn().mockRejectedValue(new Error('Ingestion failed: DB error')),
  };
}

// ─── Helpers ──────────────────────────────────────────────

let mockProvider: MockStreamingProvider;

function makeDeps(overrides?: Partial<ChatRouterDependencies>): ChatRouterDependencies {
  return { llmProvider: mockProvider, ...overrides };
}

async function postChat(body: unknown, deps?: ChatRouterDependencies): Promise<Response> {
  const app = createChatRouter(deps ?? makeDeps());
  const request = new Request('http://localhost/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return app.fetch(request);
}

function parseSSEEvents(text: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    const lines = block.split('\n');
    let event = '';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7);
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

beforeEach(() => {
  mockProvider = new MockStreamingProvider();
});

// ─── TraceCollector ───────────────────────────────────────

describe('TraceCollector', () => {
  it('collects trace events', () => {
    const collector = new TraceCollector();
    const event: TraceEvent = { stage: 'recall', status: 'start', timestamp: new Date().toISOString() };
    collector.add(event);
    expect(collector.count).toBe(1);
    expect(collector.getAll()).toEqual([event]);
  });

  it('returns immutable copy from getAll()', () => {
    const collector = new TraceCollector();
    collector.add({ stage: 'recall', status: 'start', timestamp: new Date().toISOString() });
    const all = collector.getAll();
    all.push({ stage: 'fake', status: 'start', timestamp: '' });
    expect(collector.count).toBe(1); // original unaffected
  });

  it('filters by stage', () => {
    const collector = new TraceCollector();
    collector.add({ stage: 'recall', status: 'start', timestamp: new Date().toISOString() });
    collector.add({ stage: 'llm', status: 'start', timestamp: new Date().toISOString() });
    collector.add({ stage: 'recall', status: 'complete', durationMs: 5, timestamp: new Date().toISOString() });
    expect(collector.getByStage('recall').length).toBe(2);
    expect(collector.getByStage('llm').length).toBe(1);
    expect(collector.getByStage('missing').length).toBe(0);
  });

  it('computes stage summary correctly', () => {
    const collector = new TraceCollector();
    collector.add({ stage: 'recall', status: 'start', timestamp: new Date().toISOString() });
    collector.add({ stage: 'recall', status: 'complete', durationMs: 10.5, timestamp: new Date().toISOString() });
    collector.add({ stage: 'format', status: 'complete', durationMs: 0.05, timestamp: new Date().toISOString() });
    collector.add({ stage: 'inject', status: 'complete', durationMs: 0.05, timestamp: new Date().toISOString() });
    collector.add({ stage: 'llm', status: 'start', timestamp: new Date().toISOString() });
    collector.add({ stage: 'llm', status: 'error', durationMs: 500, timestamp: new Date().toISOString() });
    collector.add({ stage: 'ingestion', status: 'skipped', timestamp: new Date().toISOString() });

    const summary = collector.getStageSummary();
    expect(summary).toEqual([
      { stage: 'recall', status: 'complete', durationMs: 10.5 },
      { stage: 'format', status: 'complete', durationMs: 0.05 },
      { stage: 'inject', status: 'complete', durationMs: 0.05 },
      { stage: 'llm', status: 'error', durationMs: 500 },
      { stage: 'ingestion', status: 'skipped' },
    ]);
  });

  it('stage summary omits durationMs when undefined', () => {
    const collector = new TraceCollector();
    collector.add({ stage: 'ingestion', status: 'skipped', timestamp: new Date().toISOString() });
    const summary = collector.getStageSummary();
    expect(summary[0]).toEqual({ stage: 'ingestion', status: 'skipped' });
    expect('durationMs' in summary[0]!).toBe(false);
  });
});

// ─── safeSerialize ────────────────────────────────────────

describe('safeSerialize', () => {
  it('serializes plain objects', () => {
    expect(safeSerialize({ a: 1 })).toBe('{"a":1}');
  });

  it('passes through strings unchanged', () => {
    expect(safeSerialize('[DONE]')).toBe('[DONE]');
  });

  it('handles circular references', () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    const result = safeSerialize(obj);
    expect(result).toContain('"a":1');
    expect(result).toContain('[Circular]');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('handles BigInt values', () => {
    const obj = { big: BigInt(12345678901234567890n) };
    const result = safeSerialize(obj);
    expect(result).toContain('12345678901234567890');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('handles null', () => {
    expect(safeSerialize(null)).toBe('null');
  });

  it('handles undefined gracefully', () => {
    // undefined is not valid JSON; safeSerialize returns a fallback
    const result = safeSerialize(undefined);
    expect(typeof result).toBe('string');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('truncates oversized payloads', () => {
    const large = { data: 'x'.repeat(100_000) };
    const result = safeSerialize(large);
    const parsed = JSON.parse(result);
    expect(parsed._truncated).toBe(true);
    expect(parsed._originalSize).toBeGreaterThan(64 * 1024);
    expect(parsed._preview).toBeDefined();
  });

  it('handles nested objects without circular refs', () => {
    const nested = { a: { b: { c: { d: [1, 2, 3] } } } };
    expect(safeSerialize(nested)).toBe(JSON.stringify(nested));
  });
});

// ─── formatSSE with safe serialization ────────────────────

describe('formatSSE — safe serialization', () => {
  it('formats normal objects (backward compatible)', () => {
    const result = formatSSE('chat', { type: 'delta', content: 'hello' });
    expect(result).toBe('event: chat\ndata: {"type":"delta","content":"hello"}\n\n');
  });

  it('formats raw strings (backward compatible)', () => {
    expect(formatSSE('done', '[DONE]')).toBe('event: done\ndata: [DONE]\n\n');
  });

  it('handles circular references gracefully', () => {
    const obj: any = { stage: 'test' };
    obj.self = obj;
    const result = formatSSE('trace', obj);
    expect(result).toContain('event: trace\n');
    expect(result).toContain('[Circular]');
    expect(result.endsWith('\n\n')).toBe(true);
  });

  it('handles BigInt in trace data', () => {
    const result = formatSSE('trace', { stage: 'test', bigValue: BigInt(42) });
    expect(result).toContain('"bigValue":"42"');
  });
});

// ─── format + inject trace stages (replaced context-build) ──

describe('POST /chat — format + inject trace stages', () => {
  it('emits format:start and format:complete trace events', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const formatStart = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'format' && (e.data as TraceEvent).status === 'start',
    );
    const formatComplete = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'format' && (e.data as TraceEvent).status === 'complete',
    );
    expect(formatStart).toBeDefined();
    expect(formatComplete).toBeDefined();
    expect(typeof (formatComplete!.data as TraceEvent).durationMs).toBe('number');
  });

  it('inject:complete includes message count and prompt length', async () => {
    const response = await postChat({
      message: 'hello',
      history: [{ role: 'user', content: 'prev' }, { role: 'assistant', content: 'reply' }],
    });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const injectComplete = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'inject' && (e.data as TraceEvent).status === 'complete',
    );
    const data = (injectComplete!.data as TraceEvent).data as any;
    expect(data.messageCount).toBe(3); // 2 history + 1 current
    expect(data.finalPromptLength).toBeGreaterThan(0);
    expect(data.hasMemoryContext).toBe(false);
  });

  it('inject:complete reflects memory context when retriever provided', async () => {
    const retriever = createMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const response = await postChat({ message: 'TypeScript tips' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const injectComplete = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'inject' && (e.data as TraceEvent).status === 'complete',
    );
    const data = (injectComplete!.data as TraceEvent).data as any;
    expect(data.hasMemoryContext).toBe(true);
    expect(data.finalPromptLength).toBeGreaterThan(0);
  });

  it('format + inject appear between recall and llm', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const sequence = events.map((e) => {
      if (e.event === 'trace') return `trace:${(e.data as TraceEvent).stage}:${(e.data as TraceEvent).status}`;
      if (e.event === 'chat') return `chat:${(e.data as ChatEvent).type}`;
      return e.event;
    });

    const recallIdx = sequence.findIndex((s) => s.startsWith('trace:recall'));
    const formatStartIdx = sequence.indexOf('trace:format:start');
    const injectCompleteIdx = sequence.indexOf('trace:inject:complete');
    const llmStartIdx = sequence.indexOf('trace:llm:start');

    expect(formatStartIdx).toBeGreaterThan(recallIdx);
    expect(injectCompleteIdx).toBeLessThan(llmStartIdx);
  });
});

// ─── ingestion trace stage ────────────────────────────────

describe('POST /chat — ingestion trace stage', () => {
  it('emits ingestion:skipped when no ingestion handler', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionSkipped = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'ingestion' && (e.data as TraceEvent).status === 'skipped',
    );
    expect(ingestionSkipped).toBeDefined();
  });

  it('emits ingestion:start and ingestion:complete with ingestion handler', async () => {
    const handler = createMockIngestionHandler();
    const deps = makeDeps({ ingestionHandler: handler });

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionStart = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'ingestion' && (e.data as TraceEvent).status === 'start',
    );
    expect(ingestionStart).toBeDefined();

    const ingestionComplete = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'ingestion' && (e.data as TraceEvent).status === 'complete',
    );
    expect(ingestionComplete).toBeDefined();
    const data = (ingestionComplete!.data as TraceEvent).data as any;
    expect(data.factCount).toBe(2);
    expect(data.facts).toHaveLength(2);
    expect(typeof (ingestionComplete!.data as TraceEvent).durationMs).toBe('number');
  });

  it('emits ingestion:error when handler fails', async () => {
    const handler = createErrorIngestionHandler();
    const deps = makeDeps({ ingestionHandler: handler });

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionError = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'ingestion' && (e.data as TraceEvent).status === 'error',
    );
    expect(ingestionError).toBeDefined();
    const data = (ingestionError!.data as TraceEvent).data as any;
    expect(data.error).toContain('Ingestion failed');

    // Should still get done event (non-fatal)
    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent).toBeDefined();
  });

  it('skips ingestion when LLM response is empty', async () => {
    mockProvider.streamError = new Error('LLM error');
    const handler = createMockIngestionHandler();
    const deps = makeDeps({ ingestionHandler: handler });

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionSkipped = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'ingestion' && (e.data as TraceEvent).status === 'skipped',
    );
    expect(ingestionSkipped).toBeDefined();
    const data = (ingestionSkipped!.data as TraceEvent).data as any;
    expect(data.reason).toContain('Empty response');
  });

  it('ingestion appears after llm:complete', async () => {
    const handler = createMockIngestionHandler();
    const deps = makeDeps({ ingestionHandler: handler });

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const sequence = events.map((e) => {
      if (e.event === 'trace') return `trace:${(e.data as TraceEvent).stage}:${(e.data as TraceEvent).status}`;
      return e.event;
    });

    const llmCompleteIdx = sequence.indexOf('trace:llm:complete');
    const ingestionStartIdx = sequence.indexOf('trace:ingestion:start');
    const ingestionCompleteIdx = sequence.indexOf('trace:ingestion:complete');
    const pipelineCompleteIdx = sequence.indexOf('trace:pipeline:complete');

    expect(ingestionStartIdx).toBeGreaterThan(llmCompleteIdx);
    expect(ingestionCompleteIdx).toBeGreaterThan(ingestionStartIdx);
    expect(pipelineCompleteIdx).toBeGreaterThan(ingestionCompleteIdx);
  });

  it('passes correct params to ingestion handler', async () => {
    const handler = createMockIngestionHandler();
    const deps = makeDeps({ ingestionHandler: handler });

    const response = await postChat({ message: 'test question', sessionId: 'sess-1' }, deps);
    await response.text();

    expect(handler.ingest).toHaveBeenCalledWith({
      userMessage: 'test question',
      assistantMessage: 'Hello world',
      sessionId: 'sess-1',
    });
  });
});

// ─── DoneEvent with traceEvents ───────────────────────────

describe('POST /chat — DoneEvent with traceEvents', () => {
  it('done event includes traceEvents array', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent).toBeDefined();
    const doneData = doneEvent!.data as DoneEvent;
    expect(doneData.traceEvents).toBeDefined();
    expect(Array.isArray(doneData.traceEvents)).toBe(true);
  });

  it('traceEvents in done event matches streamed trace events', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const streamedTraces = events
      .filter((e) => e.event === 'trace')
      .map((e) => e.data as TraceEvent);

    const doneData = events.find((e) => e.event === 'done')!.data as DoneEvent;

    // Should contain all the streamed trace events
    expect(doneData.traceEvents!.length).toBe(streamedTraces.length);
    for (let i = 0; i < streamedTraces.length; i++) {
      expect(doneData.traceEvents![i]!.stage).toBe(streamedTraces[i]!.stage);
      expect(doneData.traceEvents![i]!.status).toBe(streamedTraces[i]!.status);
    }
  });

  it('traceEvents includes all pipeline stages', async () => {
    const handler = createMockIngestionHandler();
    const retriever = createMockRetriever();
    const deps = makeDeps({ retriever: retriever as any, ingestionHandler: handler });

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const doneData = events.find((e) => e.event === 'done')!.data as DoneEvent;
    const stages = doneData.traceEvents!.map((e) => e.stage);

    expect(stages).toContain('recall');
    expect(stages).toContain('format');
    expect(stages).toContain('inject');
    expect(stages).toContain('llm');
    expect(stages).toContain('ingestion');
    expect(stages).toContain('pipeline');
  });
});

// ─── Pipeline complete with stage summary ─────────────────

describe('POST /chat — pipeline:complete stage summary', () => {
  it('pipeline:complete includes stages array', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const pipelineComplete = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'pipeline' && (e.data as TraceEvent).status === 'complete',
    );
    expect(pipelineComplete).toBeDefined();
    const data = (pipelineComplete!.data as TraceEvent).data as any;
    expect(data.stages).toBeDefined();
    expect(Array.isArray(data.stages)).toBe(true);
    expect(data.stages.length).toBeGreaterThanOrEqual(4); // recall + format + inject + llm + ingestion (at minimum)
  });

  it('stages summary contains all completed/skipped/errored stages', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const pipelineComplete = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'pipeline',
    );
    const data = (pipelineComplete!.data as TraceEvent).data as any;
    const stageNames = data.stages.map((s: any) => s.stage);

    expect(stageNames).toContain('recall');
    expect(stageNames).toContain('format');
    expect(stageNames).toContain('inject');
    expect(stageNames).toContain('llm');
    expect(stageNames).toContain('ingestion');
  });
});

// ─── Full event ordering with all stages ──────────────────

describe('POST /chat — full event ordering with all stages', () => {
  it('emits all stages in correct order: recall → format → inject → llm → ingestion → pipeline → done', async () => {
    const handler = createMockIngestionHandler();
    const retriever = createMockRetriever();
    const deps = makeDeps({ retriever: retriever as any, ingestionHandler: handler });

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const sequence = events.map((e) => {
      if (e.event === 'trace') {
        const t = e.data as TraceEvent;
        return `trace:${t.stage}:${t.status}`;
      }
      if (e.event === 'chat') return `chat:${(e.data as ChatEvent).type}`;
      return e.event;
    });

    const recallStart = sequence.indexOf('trace:recall:start');
    const recallComplete = sequence.indexOf('trace:recall:complete');
    const formatStart = sequence.indexOf('trace:format:start');
    const injectComplete = sequence.indexOf('trace:inject:complete');
    const llmStart = sequence.indexOf('trace:llm:start');
    const firstDelta = sequence.indexOf('chat:delta');
    const chatFinish = sequence.indexOf('chat:finish');
    const llmComplete = sequence.indexOf('trace:llm:complete');
    const ingestionStart = sequence.indexOf('trace:ingestion:start');
    const ingestionComplete = sequence.indexOf('trace:ingestion:complete');
    const pipelineComplete = sequence.indexOf('trace:pipeline:complete');
    const doneIdx = sequence.indexOf('done');

    expect(recallStart).toBeLessThan(recallComplete);
    expect(recallComplete).toBeLessThan(formatStart);
    expect(injectComplete).toBeLessThan(llmStart);
    expect(llmStart).toBeLessThan(firstDelta);
    expect(firstDelta).toBeLessThan(chatFinish);
    expect(chatFinish).toBeLessThan(llmComplete);
    expect(llmComplete).toBeLessThan(ingestionStart);
    expect(ingestionStart).toBeLessThan(ingestionComplete);
    expect(ingestionComplete).toBeLessThan(pipelineComplete);
    expect(pipelineComplete).toBeLessThan(doneIdx);
  });
});
