/**
 * Tests for the Chat API Router — SSE streaming endpoint with LLM integration.
 *
 * Uses a mock LLM provider that yields controllable stream events
 * and an optional mock retriever for recall pipeline testing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createChatRouter,
  formatSSE,
  validateChatRequest,
  type ChatRequest,
  type TraceEvent,
  type ChatEvent,
  type DoneEvent,
  type ChatRouterDependencies,
} from '../src/chat/chat-router.js';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamRequest,
  LLMStreamEvent,
} from '../src/extraction/llm-provider.js';
import { openChatDatabase } from '../src/chat/db/connection.js';
import type { RecallResult, RecallQuery } from '../src/retrieval/dual-path-retriever.js';

// ─── Mock LLM Provider with streaming ─────────────────────

class MockStreamingProvider implements LLMProvider {
  readonly name = 'mock-streaming';
  public streamCalls: LLMStreamRequest[] = [];
  public completeCalls: LLMCompletionRequest[] = [];

  /** Queued stream events to yield; set before calling stream(). */
  public queuedEvents: LLMStreamEvent[] = [
    { type: 'delta', content: 'Hello' },
    { type: 'delta', content: ' world' },
    { type: 'finish', content: 'Hello world', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
  ];

  /** If set, stream() will throw this error. */
  public streamError: Error | null = null;

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    this.completeCalls.push(request);
    return { content: 'complete response' };
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    this.streamCalls.push(request);
    if (this.streamError) {
      throw this.streamError;
    }
    for (const event of this.queuedEvents) {
      yield event;
    }
  }

  reset(): void {
    this.streamCalls = [];
    this.completeCalls = [];
    this.queuedEvents = [
      { type: 'delta', content: 'Hello' },
      { type: 'delta', content: ' world' },
      { type: 'finish', content: 'Hello world', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    ];
    this.streamError = null;
  }
}

/** A provider without stream() to test fallback to complete(). */
class MockNonStreamingProvider implements LLMProvider {
  readonly name = 'mock-non-streaming';
  public completeCalls: LLMCompletionRequest[] = [];

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    this.completeCalls.push(request);
    return { content: 'buffered response', usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } };
  }
}

// ─── Mock Retriever ──────────────────────────────────────

function createMockRetriever(result?: Partial<RecallResult>) {
  const defaultResult: RecallResult = {
    items: [
      {
        nodeId: 'fact-1',
        nodeType: 'fact',
        score: 0.85,
        content: 'User likes TypeScript',
        sources: ['vector', 'graph'],
        sourceScores: { vector: 0.9, graph: 0.8 },
      } as any,
    ],
    diagnostics: {
      activatedAnchors: [],
      extractedEntities: ['TypeScript'],
      graphSeedCount: 1,
      vectorTimeMs: 12.5,
      graphTimeMs: 8.3,
      totalTimeMs: 15.0,
      vectorItemCount: 1,
      graphItemCount: 1,
      mergeStats: { totalBefore: 2, totalAfter: 1, duplicatesRemoved: 1, convergenceApplied: 0 },
      edgesReinforced: 0,
      vectorTimedOut: false,
      graphTimedOut: false,
    },
    ...result,
  };

  return {
    recall: vi.fn().mockResolvedValue(defaultResult),
  };
}

function createMockErrorRetriever() {
  return {
    recall: vi.fn().mockRejectedValue(new Error('Recall failed: DB error')),
  };
}

// ─── Helpers ──────────────────────────────────────────────

let mockProvider: MockStreamingProvider;

function makeDeps(overrides?: Partial<ChatRouterDependencies>): ChatRouterDependencies {
  return {
    llmProvider: mockProvider,
    ...overrides,
  };
}

/** Send a POST /chat request and return the raw Response. */
async function postChat(body: unknown, deps?: ChatRouterDependencies): Promise<Response> {
  const app = createChatRouter(deps ?? makeDeps());
  const request = new Request('http://localhost/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return app.fetch(request);
}

/** Parse an SSE text stream into an array of { event, data } objects. */
function parseSSEEvents(text: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split('\n');
    let event = '';
    let data = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        event = line.slice(7);
      } else if (line.startsWith('data: ')) {
        data = line.slice(6);
      }
    }

    if (event && data) {
      try {
        events.push({ event, data: JSON.parse(data) });
      } catch {
        events.push({ event, data }); // raw string data (e.g., "[DONE]")
      }
    }
  }

  return events;
}

// ─── Setup ─────────────────────────────────────────────────

beforeEach(() => {
  mockProvider = new MockStreamingProvider();
});

// ─── formatSSE ────────────────────────────────────────────

describe('formatSSE', () => {
  it('formats a JSON object event', () => {
    const result = formatSSE('chat', { type: 'delta', content: 'hello' });
    expect(result).toBe('event: chat\ndata: {"type":"delta","content":"hello"}\n\n');
  });

  it('formats a raw string event', () => {
    const result = formatSSE('done', '[DONE]');
    expect(result).toBe('event: done\ndata: [DONE]\n\n');
  });

  it('formats nested data', () => {
    const result = formatSSE('trace', { stage: 'recall', status: 'start', data: { count: 3 } });
    expect(result).toContain('event: trace\n');
    expect(result).toContain('"stage":"recall"');
    expect(result.endsWith('\n\n')).toBe(true);
  });
});

// ─── validateChatRequest ──────────────────────────────────

describe('validateChatRequest', () => {
  it('accepts a valid minimal request', () => {
    expect(validateChatRequest({ message: 'hello' })).toEqual([]);
  });

  it('accepts a fully-populated request', () => {
    const req: ChatRequest = {
      message: 'hello',
      sessionId: 'sess-1',
      history: [{ role: 'user', content: 'prev' }, { role: 'assistant', content: 'reply' }],
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.7,
      maxTokens: 1000,
    };
    expect(validateChatRequest(req)).toEqual([]);
  });

  it('rejects non-object body', () => {
    expect(validateChatRequest('string')).toEqual(['Request body must be a JSON object']);
    expect(validateChatRequest(null)).toEqual(['Request body must be a JSON object']);
    expect(validateChatRequest([1, 2])).toEqual(['Request body must be a JSON object']);
  });

  it('rejects missing message', () => {
    const errors = validateChatRequest({});
    expect(errors).toContain('`message` is required and must be a non-empty string');
  });

  it('rejects empty message', () => {
    const errors = validateChatRequest({ message: '   ' });
    expect(errors).toContain('`message` is required and must be a non-empty string');
  });

  it('rejects invalid provider', () => {
    const errors = validateChatRequest({ message: 'hi', provider: 'gemini' });
    expect(errors).toContain('`provider` must be "openai" or "anthropic"');
  });

  it('rejects invalid temperature', () => {
    const errors = validateChatRequest({ message: 'hi', temperature: 5 });
    expect(errors).toContain('`temperature` must be a number between 0 and 2');
  });

  it('rejects non-string sessionId', () => {
    const errors = validateChatRequest({ message: 'hi', sessionId: 123 });
    expect(errors).toContain('`sessionId` must be a string if provided');
  });

  it('rejects invalid history entries', () => {
    const errors = validateChatRequest({
      message: 'hi',
      history: [{ role: 'system', content: 'bad' }, { role: 'user' }],
    });
    expect(errors.some((e) => e.includes('history[0].role'))).toBe(true);
    expect(errors.some((e) => e.includes('history[1].content'))).toBe(true);
  });

  it('rejects non-array history', () => {
    const errors = validateChatRequest({ message: 'hi', history: 'not-array' });
    expect(errors).toContain('`history` must be an array if provided');
  });

  it('rejects invalid maxTokens', () => {
    expect(validateChatRequest({ message: 'hi', maxTokens: 0 })).toContain('`maxTokens` must be a positive integer');
    expect(validateChatRequest({ message: 'hi', maxTokens: 1.5 })).toContain('`maxTokens` must be a positive integer');
  });

  it('accumulates multiple errors', () => {
    const errors = validateChatRequest({ provider: 'bad', temperature: -1 });
    expect(errors.length).toBeGreaterThanOrEqual(3); // message + provider + temperature
  });
});

// ─── POST /chat — Validation errors ───────────────────────

describe('POST /chat — validation', () => {
  it('returns 400 for invalid JSON', async () => {
    const app = createChatRouter(makeDeps());
    const request = new Request('http://localhost/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json}',
    });
    const response = await app.fetch(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('INVALID_JSON');
  });

  it('returns 400 for missing message', async () => {
    const response = await postChat({});
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.details).toContain('`message` is required and must be a non-empty string');
  });
});

// ─── POST /chat — SSE streaming ────────────────────────────

describe('POST /chat — SSE streaming', () => {
  it('returns SSE response with correct headers', async () => {
    const response = await postChat({ message: 'hello' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(response.headers.get('Connection')).toBe('keep-alive');
    expect(response.headers.get('X-Accel-Buffering')).toBe('no');
  });

  it('emits recall_skipped trace when no retriever', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const recallSkipped = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'recall' && (e.data as TraceEvent).status === 'skipped',
    );
    expect(recallSkipped).toBeDefined();
    expect((recallSkipped!.data as TraceEvent).data).toEqual({ reason: 'No retriever configured' });
  });

  it('emits llm start/complete trace events', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const llmStart = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'llm' && (e.data as TraceEvent).status === 'start',
    );
    expect(llmStart).toBeDefined();
    expect((llmStart!.data as TraceEvent).data).toEqual(
      expect.objectContaining({ provider: 'mock-streaming', messageCount: 1 }),
    );

    const llmComplete = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'llm' && (e.data as TraceEvent).status === 'complete',
    );
    expect(llmComplete).toBeDefined();
    expect((llmComplete!.data as TraceEvent).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('streams chat delta events from LLM', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const chatDeltas = events.filter(
      (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'delta',
    );
    expect(chatDeltas.length).toBe(2);
    expect((chatDeltas[0]!.data as ChatEvent).content).toBe('Hello');
    expect((chatDeltas[1]!.data as ChatEvent).content).toBe(' world');
  });

  it('emits chat finish event with full content and usage', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const chatFinish = events.find(
      (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'finish',
    );
    expect(chatFinish).toBeDefined();
    const data = chatFinish!.data as ChatEvent;
    expect(data.content).toBe('Hello world');
    expect(data.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('emits pipeline complete trace with duration', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const pipelineComplete = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'pipeline' && (e.data as TraceEvent).status === 'complete',
    );
    expect(pipelineComplete).toBeDefined();
    expect((pipelineComplete!.data as TraceEvent).durationMs).toBeGreaterThanOrEqual(0);
    expect((pipelineComplete!.data as TraceEvent).data).toEqual(
      expect.objectContaining({ userId: 'debug-user' }),
    );
  });

  it('emits done event as final event', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const lastEvent = events[events.length - 1]!;
    expect(lastEvent.event).toBe('done');
    const doneData = lastEvent.data as DoneEvent;
    expect(doneData.fullResponse).toBe('Hello world');
    expect(typeof doneData.totalDurationMs).toBe('number');
  });

  it('includes timestamps in all trace events', async () => {
    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const traceEvents = events.filter((e) => e.event === 'trace');
    expect(traceEvents.length).toBeGreaterThanOrEqual(3);
    for (const evt of traceEvents) {
      const trace = evt.data as TraceEvent;
      expect(trace.timestamp).toBeDefined();
      expect(new Date(trace.timestamp).toISOString()).toBe(trace.timestamp);
    }
  });

  it('passes messages with history to LLM provider', async () => {
    const response = await postChat({
      message: 'current question',
      history: [
        { role: 'user', content: 'prev question' },
        { role: 'assistant', content: 'prev answer' },
      ],
    });
    await response.text(); // consume stream

    expect(mockProvider.streamCalls.length).toBe(1);
    const call = mockProvider.streamCalls[0]!;
    expect(call.messages).toEqual([
      { role: 'user', content: 'prev question' },
      { role: 'assistant', content: 'prev answer' },
      { role: 'user', content: 'current question' },
    ]);
  });

  it('passes temperature and maxTokens to LLM provider', async () => {
    const response = await postChat({ message: 'hi', temperature: 1.5, maxTokens: 500 });
    await response.text();

    const call = mockProvider.streamCalls[0]!;
    expect(call.temperature).toBe(1.5);
    expect(call.maxTokens).toBe(500);
  });

  it('uses default temperature 0.7 when not specified', async () => {
    const response = await postChat({ message: 'hi' });
    await response.text();

    const call = mockProvider.streamCalls[0]!;
    expect(call.temperature).toBe(0.7);
  });

  it('uses custom system prompt when provided', async () => {
    const response = await postChat({ message: 'hi', systemPrompt: 'You are a pirate.' });
    await response.text();

    const call = mockProvider.streamCalls[0]!;
    expect(call.system).toContain('You are a pirate.');
  });

  it('uses default system prompt when none provided', async () => {
    const response = await postChat({ message: 'hi' });
    await response.text();

    const call = mockProvider.streamCalls[0]!;
    expect(call.system).toContain('helpful AI assistant');
  });

  it('uses deps.defaultSystemPrompt when provided', async () => {
    const response = await postChat(
      { message: 'hi' },
      makeDeps({ defaultSystemPrompt: 'Custom default prompt' }),
    );
    await response.text();

    const call = mockProvider.streamCalls[0]!;
    expect(call.system).toContain('Custom default prompt');
  });
});

// ─── POST /chat — LLM error handling ──────────────────────

describe('POST /chat — LLM error handling', () => {
  it('emits chat error event when LLM yields an error event', async () => {
    mockProvider.queuedEvents = [
      { type: 'delta', content: 'partial' },
      { type: 'error', error: 'Rate limit exceeded' },
    ];

    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    const chatError = events.find(
      (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'error',
    );
    expect(chatError).toBeDefined();
    expect((chatError!.data as ChatEvent).error).toBe('Rate limit exceeded');

    // Should still emit done event
    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent).toBeDefined();
  });

  it('handles stream() throwing an error', async () => {
    mockProvider.streamError = new Error('Connection timeout');

    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    // Should emit chat error
    const chatError = events.find(
      (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'error',
    );
    expect(chatError).toBeDefined();
    expect((chatError!.data as ChatEvent).error).toBe('Connection timeout');

    // Should emit llm error trace
    const llmError = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'llm' && (e.data as TraceEvent).status === 'error',
    );
    expect(llmError).toBeDefined();

    // Should still emit done event
    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent).toBeDefined();
  });
});

// ─── POST /chat — Non-streaming provider fallback ─────────

describe('POST /chat — non-streaming provider fallback', () => {
  it('falls back to complete() when stream() is not available', async () => {
    const nonStreaming = new MockNonStreamingProvider();
    const deps = makeDeps({ llmProvider: nonStreaming });

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    expect(nonStreaming.completeCalls.length).toBe(1);

    // Should still get chat events
    const chatDelta = events.find(
      (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'delta',
    );
    expect(chatDelta).toBeDefined();
    expect((chatDelta!.data as ChatEvent).content).toBe('buffered response');

    const chatFinish = events.find(
      (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'finish',
    );
    expect(chatFinish).toBeDefined();
    expect((chatFinish!.data as ChatEvent).content).toBe('buffered response');
    expect((chatFinish!.data as ChatEvent).usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });

    // Trace should indicate fallback
    const llmComplete = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'llm' && (e.data as TraceEvent).status === 'complete',
    );
    expect(llmComplete).toBeDefined();
    expect((llmComplete!.data as TraceEvent).data).toEqual(
      expect.objectContaining({ fallback: 'complete' }),
    );
  });
});

// ─── POST /chat — With retriever ──────────────────────────

describe('POST /chat — with retriever', () => {
  it('emits recall start/complete traces with diagnostics', async () => {
    const retriever = createMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const response = await postChat({ message: 'TypeScript tips' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    // recall start
    const recallStart = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'recall' && (e.data as TraceEvent).status === 'start',
    );
    expect(recallStart).toBeDefined();
    expect((recallStart!.data as TraceEvent).data).toEqual(
      expect.objectContaining({ query: 'TypeScript tips', userId: 'debug-user' }),
    );

    // recall complete
    const recallComplete = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'recall' && (e.data as TraceEvent).status === 'complete',
    );
    expect(recallComplete).toBeDefined();
    const recallData = (recallComplete!.data as TraceEvent).data as any;
    expect(recallData.itemCount).toBe(1);
    expect(recallData.diagnostics).toBeDefined();
    expect(recallData.diagnostics.extractedEntities).toEqual(['TypeScript']);
  });

  it('appends memory context to system prompt', async () => {
    const retriever = createMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const response = await postChat({ message: 'TypeScript tips' }, deps);
    await response.text();

    const call = mockProvider.streamCalls[0]!;
    expect(call.system).toContain('Retrieved Memory Context');
    expect(call.system).toContain('User likes TypeScript');
  });

  it('indicates hasMemoryContext in llm start trace', async () => {
    const retriever = createMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const llmStart = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'llm' && (e.data as TraceEvent).status === 'start',
    );
    expect((llmStart!.data as TraceEvent).data).toEqual(
      expect.objectContaining({ hasMemoryContext: true }),
    );
  });

  it('continues without context when retriever returns empty results', async () => {
    const retriever = createMockRetriever({ items: [] });
    const deps = makeDeps({ retriever: retriever as any });

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const llmStart = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'llm' && (e.data as TraceEvent).status === 'start',
    );
    expect((llmStart!.data as TraceEvent).data).toEqual(
      expect.objectContaining({ hasMemoryContext: false }),
    );

    // System prompt should NOT contain memory context
    const call = mockProvider.streamCalls[0]!;
    expect(call.system).not.toContain('Retrieved Memory Context');
  });

  it('handles retriever errors gracefully (non-fatal)', async () => {
    const retriever = createMockErrorRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    // Should emit recall error trace
    const recallError = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'recall' && (e.data as TraceEvent).status === 'error',
    );
    expect(recallError).toBeDefined();
    expect((recallError!.data as TraceEvent).data).toEqual(
      expect.objectContaining({ error: 'Recall failed: DB error' }),
    );

    // Should still proceed to LLM
    const llmStart = events.find(
      (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'llm' && (e.data as TraceEvent).status === 'start',
    );
    expect(llmStart).toBeDefined();

    // Should still get chat events and done
    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent).toBeDefined();
  });
});

// ─── POST /chat — Full event order ────────────────────────

describe('POST /chat — event ordering', () => {
  it('emits events in correct order: recall → llm → chat → pipeline → done', async () => {
    const retriever = createMockRetriever();
    const deps = makeDeps({ retriever: retriever as any });

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    // Extract event sequence
    const sequence = events.map((e) => {
      if (e.event === 'trace') {
        const t = e.data as TraceEvent;
        return `trace:${t.stage}:${t.status}`;
      }
      if (e.event === 'chat') {
        return `chat:${(e.data as ChatEvent).type}`;
      }
      return e.event;
    });

    // Verify ordering
    const recallStartIdx = sequence.indexOf('trace:recall:start');
    const recallCompleteIdx = sequence.indexOf('trace:recall:complete');
    const llmStartIdx = sequence.indexOf('trace:llm:start');
    const firstDeltaIdx = sequence.indexOf('chat:delta');
    const finishIdx = sequence.indexOf('chat:finish');
    const llmCompleteIdx = sequence.indexOf('trace:llm:complete');
    const pipelineCompleteIdx = sequence.indexOf('trace:pipeline:complete');
    const doneIdx = sequence.indexOf('done');

    expect(recallStartIdx).toBeLessThan(recallCompleteIdx);
    expect(recallCompleteIdx).toBeLessThan(llmStartIdx);
    expect(llmStartIdx).toBeLessThan(firstDeltaIdx);
    expect(firstDeltaIdx).toBeLessThan(finishIdx);
    expect(finishIdx).toBeLessThan(llmCompleteIdx);
    expect(llmCompleteIdx).toBeLessThan(pipelineCompleteIdx);
    expect(pipelineCompleteIdx).toBeLessThan(doneIdx);
  });

  it('done is always the last event even with errors', async () => {
    mockProvider.streamError = new Error('Test error');

    const response = await postChat({ message: 'hello' });
    const text = await response.text();
    const events = parseSSEEvents(text);

    expect(events[events.length - 1]!.event).toBe('done');
  });
});

describe('POST /chat — persistence', () => {
  it('persists SSE trace events into chat_trace_events with monotonic trace ids', async () => {
    const chatDb = openChatDatabase({ inMemory: true });

    try {
      const response = await postChat(
        { message: 'persist this trace' },
        makeDeps({ chatDb }),
      );

      expect(response.status).toBe(200);
      await response.text();

      const traceIds = chatDb
        .prepare('SELECT trace_id FROM chat_trace_events ORDER BY trace_id ASC')
        .all() as Array<{ trace_id: number }>;

      expect(traceIds.length).toBeGreaterThan(0);
      expect(traceIds.map((row) => row.trace_id)).toEqual(
        Array.from({ length: traceIds.length }, (_, i) => i + 1),
      );
    } finally {
      chatDb.close();
    }
  });
});

// ─── GET /chat/health ─────────────────────────────────────

describe('GET /chat/health', () => {
  it('returns health status with provider info', async () => {
    const app = createChatRouter(makeDeps());
    const request = new Request('http://localhost/chat/health', { method: 'GET' });
    const response = await app.fetch(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.subsystem).toBe('chat');
    expect(body.provider).toBe('mock-streaming');
    expect(body.hasRetriever).toBe(false);
    expect(body.userId).toBe('debug-user');
  });

  it('reflects retriever availability', async () => {
    const retriever = createMockRetriever();
    const app = createChatRouter(makeDeps({ retriever: retriever as any }));
    const request = new Request('http://localhost/chat/health', { method: 'GET' });
    const response = await app.fetch(request);
    const body = await response.json();
    expect(body.hasRetriever).toBe(true);
  });
});
