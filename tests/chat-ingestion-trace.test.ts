/**
 * Tests for ingestion pipeline tracing in the Chat API Router.
 *
 * Verifies that event:trace events with stage "ingestion" are emitted
 * during the fact extraction phase, including:
 *   - ingestion start trace with user message and response length
 *   - ingestion complete trace with raw fact JSON
 *   - ingestion error trace when extraction fails
 *   - ingestion skipped trace when no extractor is configured
 *   - EventBus integration for facts.extracted and extraction.error events
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createChatRouter,
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
import type { FactExtractor, FactExtractionResult } from '../src/extraction/fact-extractor.js';
import type { FactExtractionInput, Fact } from '../src/models/fact.js';
import { EventBus } from '../src/events/event-bus.js';

// ─── Mock LLM Provider ─────────────────────────────────

class MockStreamingProvider implements LLMProvider {
  readonly name = 'mock-streaming';

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    return { content: 'complete response' };
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    yield { type: 'delta', content: 'Hello' };
    yield { type: 'delta', content: ' world' };
    yield {
      type: 'finish',
      content: 'Hello world',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
}

// ─── Mock Fact Extractor ────────────────────────────────

function createMockFact(overrides?: Partial<Fact>): Fact {
  return {
    id: 'fact-001',
    conversationId: 'conv-1',
    sourceMessageIds: ['msg-1', 'msg-2'],
    sourceTurnIndex: 0,
    content: 'User prefers TypeScript over JavaScript',
    category: 'preference',
    confidence: 0.92,
    entities: ['TypeScript', 'JavaScript'],
    subject: 'User',
    predicate: 'prefers',
    object: 'TypeScript',
    superseded: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    metadata: { extractionModel: 'mock' },
    ...overrides,
  };
}

function createMockFactExtractor(result?: FactExtractionResult): FactExtractor {
  const defaultResult: FactExtractionResult = {
    ok: true,
    facts: [
      createMockFact(),
      createMockFact({
        id: 'fact-002',
        content: 'User is building a memory system',
        category: 'context',
        confidence: 0.85,
        entities: ['memory system'],
        subject: 'User',
        predicate: 'is building',
        object: 'memory system',
      }),
    ],
    rawResponse: '{"facts":[{"content":"User prefers TypeScript over JavaScript","category":"preference","confidence":0.92,"entities":["TypeScript","JavaScript"],"subject":"User","predicate":"prefers","object":"TypeScript"},{"content":"User is building a memory system","category":"context","confidence":0.85,"entities":["memory system"],"subject":"User","predicate":"is building","object":"memory system"}]}',
  };

  return {
    extractFromTurn: vi.fn().mockResolvedValue(result ?? defaultResult),
    extractFromTurns: vi.fn().mockResolvedValue([result ?? defaultResult]),
  } as unknown as FactExtractor;
}

function createErrorFactExtractor(error: string): FactExtractor {
  return {
    extractFromTurn: vi.fn().mockResolvedValue({
      ok: false,
      facts: [],
      error,
      rawResponse: '{"invalid": "json response"}',
    } satisfies FactExtractionResult),
    extractFromTurns: vi.fn(),
  } as unknown as FactExtractor;
}

function createThrowingFactExtractor(errorMsg: string): FactExtractor {
  return {
    extractFromTurn: vi.fn().mockRejectedValue(new Error(errorMsg)),
    extractFromTurns: vi.fn(),
  } as unknown as FactExtractor;
}

// ─── SSE Helpers ────────────────────────────────────────

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
        events.push({ event, data });
      }
    }
  }

  return events;
}

async function postChat(body: unknown, deps: ChatRouterDependencies): Promise<Response> {
  const app = createChatRouter(deps);
  const request = new Request('http://localhost/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return app.fetch(request);
}

function getTraceEvents(events: Array<{ event: string; data: unknown }>, stage: string) {
  return events.filter(
    (e) => e.event === 'trace' && (e.data as TraceEvent).stage === stage,
  );
}

// ─── Tests ──────────────────────────────────────────────

let mockProvider: MockStreamingProvider;

beforeEach(() => {
  mockProvider = new MockStreamingProvider();
});

describe('POST /chat — ingestion trace: skipped', () => {
  it('emits ingestion skipped trace when no fact extractor is configured', async () => {
    const deps: ChatRouterDependencies = { llmProvider: mockProvider };

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionEvents = getTraceEvents(events, 'ingestion');
    expect(ingestionEvents.length).toBe(1);

    const trace = ingestionEvents[0]!.data as TraceEvent;
    expect(trace.stage).toBe('ingestion');
    expect(trace.status).toBe('skipped');
    expect(trace.data).toEqual({ reason: 'No fact extractor configured' });
  });

  it('emits ingestion skipped trace when LLM response is empty', async () => {
    // Provider that yields empty response
    const emptyProvider: LLMProvider = {
      name: 'mock-empty',
      async complete() {
        return { content: '' };
      },
      async *stream() {
        yield { type: 'finish' as const, content: '' };
      },
    };

    const factExtractor = createMockFactExtractor();
    const deps: ChatRouterDependencies = {
      llmProvider: emptyProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionEvents = getTraceEvents(events, 'ingestion');
    expect(ingestionEvents.length).toBe(1);

    const trace = ingestionEvents[0]!.data as TraceEvent;
    expect(trace.status).toBe('skipped');
    expect(trace.data).toEqual({ reason: 'Empty response — no facts to extract' });

    // FactExtractor should NOT have been called
    expect(factExtractor.extractFromTurn).not.toHaveBeenCalled();
  });
});

describe('POST /chat — ingestion trace: success', () => {
  it('emits ingestion start + complete traces with raw fact JSON', async () => {
    const factExtractor = createMockFactExtractor();
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'I prefer TypeScript' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionEvents = getTraceEvents(events, 'ingestion');
    expect(ingestionEvents.length).toBe(2);

    // Start trace
    const startTrace = ingestionEvents[0]!.data as TraceEvent;
    expect(startTrace.stage).toBe('ingestion');
    expect(startTrace.status).toBe('start');
    expect(startTrace.data).toEqual(
      expect.objectContaining({
        userMessage: 'I prefer TypeScript',
        assistantResponseLength: 11, // 'Hello world'
      }),
    );

    // Complete trace
    const completeTrace = ingestionEvents[1]!.data as TraceEvent;
    expect(completeTrace.stage).toBe('ingestion');
    expect(completeTrace.status).toBe('complete');
    expect(completeTrace.durationMs).toBeGreaterThanOrEqual(0);

    const data = completeTrace.data as any;
    expect(data.factCount).toBe(2);
    expect(data.facts).toHaveLength(2);
    expect(data.facts[0].content).toBe('User prefers TypeScript over JavaScript');
    expect(data.facts[0].category).toBe('preference');
    expect(data.facts[0].confidence).toBe(0.92);
    expect(data.facts[0].entities).toEqual(['TypeScript', 'JavaScript']);
    expect(data.facts[0].subject).toBe('User');
    expect(data.facts[0].predicate).toBe('prefers');
    expect(data.facts[0].object).toBe('TypeScript');
  });

  it('passes correct extraction input to fact extractor', async () => {
    const factExtractor = createMockFactExtractor();
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
      conversationId: 'test-conv-123',
    };

    const response = await postChat(
      {
        message: 'Tell me about TypeScript',
        history: [
          { role: 'user', content: 'prev question' },
          { role: 'assistant', content: 'prev answer' },
        ],
      },
      deps,
    );
    await response.text();

    expect(factExtractor.extractFromTurn).toHaveBeenCalledTimes(1);
    const input = (factExtractor.extractFromTurn as any).mock.calls[0][0] as FactExtractionInput;
    expect(input.conversationId).toBe('test-conv-123');
    expect(input.userMessage.content).toBe('Tell me about TypeScript');
    expect(input.userMessage.turnIndex).toBe(2); // history has 2 messages
    expect(input.assistantMessage.content).toBe('Hello world');
    expect(input.assistantMessage.turnIndex).toBe(3);
    expect(input.priorContext).toContain('[user]: prev question');
    expect(input.priorContext).toContain('[assistant]: prev answer');
  });

  it('generates a conversation ID when not provided', async () => {
    const factExtractor = createMockFactExtractor();
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'hello' }, deps);
    await response.text();

    const input = (factExtractor.extractFromTurn as any).mock.calls[0][0] as FactExtractionInput;
    expect(input.conversationId).toMatch(/^debug-chat-/);
  });

  it('handles extraction with zero facts gracefully', async () => {
    const factExtractor = createMockFactExtractor({
      ok: true,
      facts: [],
    });
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionEvents = getTraceEvents(events, 'ingestion');
    expect(ingestionEvents.length).toBe(2);

    const completeTrace = ingestionEvents[1]!.data as TraceEvent;
    expect(completeTrace.status).toBe('complete');
    const data = completeTrace.data as any;
    expect(data.factCount).toBe(0);
    expect(data.facts).toEqual([]);
  });

  it('includes fact id in trace data', async () => {
    const factExtractor = createMockFactExtractor();
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const completeTrace = getTraceEvents(events, 'ingestion')[1]!.data as TraceEvent;
    const data = completeTrace.data as any;
    expect(data.facts[0].id).toBe('fact-001');
    expect(data.facts[1].id).toBe('fact-002');
  });

  it('includes rawResponse (raw LLM JSON) in success ingestion trace', async () => {
    const factExtractor = createMockFactExtractor();
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'I prefer TypeScript' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const completeTrace = getTraceEvents(events, 'ingestion')[1]!.data as TraceEvent;
    expect(completeTrace.status).toBe('complete');
    const data = completeTrace.data as any;

    // rawResponse should be present — the raw LLM JSON for debugging
    expect(data.rawResponse).toBeDefined();
    expect(typeof data.rawResponse).toBe('string');

    // It should be parseable JSON containing facts
    const parsed = JSON.parse(data.rawResponse);
    expect(parsed.facts).toBeDefined();
    expect(parsed.facts.length).toBeGreaterThan(0);
  });

  it('includes rawResponse in error ingestion trace', async () => {
    const factExtractor = createErrorFactExtractor('Parse error');
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const errorTrace = getTraceEvents(events, 'ingestion')[1]!.data as TraceEvent;
    expect(errorTrace.status).toBe('error');
    const data = errorTrace.data as any;

    // rawResponse should be present on error traces too
    expect(data.rawResponse).toBeDefined();
    expect(data.rawResponse).toBe('{"invalid": "json response"}');
  });

  it('truncates long user messages in start trace', async () => {
    const factExtractor = createMockFactExtractor();
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const longMessage = 'x'.repeat(500);
    const response = await postChat({ message: longMessage }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const startTrace = getTraceEvents(events, 'ingestion')[0]!.data as TraceEvent;
    const data = startTrace.data as any;
    expect(data.userMessage.length).toBe(200); // truncated
  });
});

describe('POST /chat — ingestion trace: error', () => {
  it('emits ingestion error trace when extraction fails (result.ok=false)', async () => {
    const factExtractor = createErrorFactExtractor('Failed to parse LLM response');
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionEvents = getTraceEvents(events, 'ingestion');
    expect(ingestionEvents.length).toBe(2);

    // Start trace
    expect((ingestionEvents[0]!.data as TraceEvent).status).toBe('start');

    // Error trace
    const errorTrace = ingestionEvents[1]!.data as TraceEvent;
    expect(errorTrace.status).toBe('error');
    expect(errorTrace.durationMs).toBeGreaterThanOrEqual(0);
    expect((errorTrace.data as any).error).toBe('Failed to parse LLM response');
    expect((errorTrace.data as any).rawResponse).toBe('{"invalid": "json response"}');
  });

  it('emits ingestion error trace when extractor throws', async () => {
    const factExtractor = createThrowingFactExtractor('Network error');
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionEvents = getTraceEvents(events, 'ingestion');
    expect(ingestionEvents.length).toBe(2);

    const errorTrace = ingestionEvents[1]!.data as TraceEvent;
    expect(errorTrace.status).toBe('error');
    expect((errorTrace.data as any).error).toBe('Network error');
  });

  it('ingestion error does not prevent pipeline completion', async () => {
    const factExtractor = createThrowingFactExtractor('Extraction crashed');
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    // Pipeline should still complete
    const pipelineComplete = events.find(
      (e) =>
        e.event === 'trace' &&
        (e.data as TraceEvent).stage === 'pipeline' &&
        (e.data as TraceEvent).status === 'complete',
    );
    expect(pipelineComplete).toBeDefined();

    // Done event should still be emitted
    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent).toBeDefined();
  });
});

describe('POST /chat — ingestion trace: EventBus integration', () => {
  it('emits facts.extracted event on EventBus when facts are extracted', async () => {
    const factExtractor = createMockFactExtractor();
    const eventBus = new EventBus();
    const factsHandler = vi.fn();
    eventBus.on('facts.extracted', factsHandler);

    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
      eventBus,
      conversationId: 'test-conv',
    };

    const response = await postChat({ message: 'hello' }, deps);
    await response.text();

    // Allow async event processing
    await new Promise((r) => setTimeout(r, 50));

    expect(factsHandler).toHaveBeenCalledTimes(1);
    const emittedEvent = factsHandler.mock.calls[0][0];
    expect(emittedEvent.type).toBe('facts.extracted');
    expect(emittedEvent.conversationId).toBe('test-conv');
    expect(emittedEvent.facts).toHaveLength(2);
    expect(emittedEvent.timestamp).toBeDefined();
  });

  it('does not emit facts.extracted when no facts are extracted', async () => {
    const factExtractor = createMockFactExtractor({ ok: true, facts: [] });
    const eventBus = new EventBus();
    const factsHandler = vi.fn();
    eventBus.on('facts.extracted', factsHandler);

    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
      eventBus,
    };

    const response = await postChat({ message: 'hello' }, deps);
    await response.text();

    await new Promise((r) => setTimeout(r, 50));

    expect(factsHandler).not.toHaveBeenCalled();
  });

  it('emits extraction.error event on EventBus when extraction fails', async () => {
    const factExtractor = createErrorFactExtractor('Parse error');
    const eventBus = new EventBus();
    const errorHandler = vi.fn();
    eventBus.on('extraction.error', errorHandler);

    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
      eventBus,
      conversationId: 'test-conv',
    };

    const response = await postChat({ message: 'hello' }, deps);
    await response.text();

    await new Promise((r) => setTimeout(r, 50));

    expect(errorHandler).toHaveBeenCalledTimes(1);
    const emittedEvent = errorHandler.mock.calls[0][0];
    expect(emittedEvent.type).toBe('extraction.error');
    expect(emittedEvent.conversationId).toBe('test-conv');
    expect(emittedEvent.error).toBe('Parse error');
  });
});

describe('POST /chat — ingestion trace: event ordering', () => {
  it('ingestion trace comes after llm complete and before pipeline complete', async () => {
    const factExtractor = createMockFactExtractor();
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

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

    const llmCompleteIdx = sequence.indexOf('trace:llm:complete');
    const ingestionStartIdx = sequence.indexOf('trace:ingestion:start');
    const ingestionCompleteIdx = sequence.indexOf('trace:ingestion:complete');
    const pipelineCompleteIdx = sequence.indexOf('trace:pipeline:complete');
    const doneIdx = sequence.indexOf('done');

    expect(llmCompleteIdx).toBeLessThan(ingestionStartIdx);
    expect(ingestionStartIdx).toBeLessThan(ingestionCompleteIdx);
    expect(ingestionCompleteIdx).toBeLessThan(pipelineCompleteIdx);
    expect(pipelineCompleteIdx).toBeLessThan(doneIdx);
  });

  it('pipeline complete includes factCount in data', async () => {
    const factExtractor = createMockFactExtractor();
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const pipelineComplete = events.find(
      (e) =>
        e.event === 'trace' &&
        (e.data as TraceEvent).stage === 'pipeline' &&
        (e.data as TraceEvent).status === 'complete',
    );
    expect(pipelineComplete).toBeDefined();
    const data = (pipelineComplete!.data as TraceEvent).data as any;
    expect(data.factCount).toBe(2);
  });
});

describe('POST /chat — ingestion trace: with history context', () => {
  it('builds prior context from conversation history for extraction', async () => {
    const factExtractor = createMockFactExtractor();
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat(
      {
        message: 'I use TypeScript',
        history: [
          { role: 'user', content: 'What languages do you support?' },
          { role: 'assistant', content: 'I support many languages including TypeScript.' },
          { role: 'user', content: 'Which do you recommend?' },
          { role: 'assistant', content: 'TypeScript is great for large projects.' },
        ],
      },
      deps,
    );
    await response.text();

    const input = (factExtractor.extractFromTurn as any).mock.calls[0][0] as FactExtractionInput;
    expect(input.priorContext).toContain('What languages do you support?');
    expect(input.priorContext).toContain('TypeScript is great for large projects.');
    expect(input.userMessage.turnIndex).toBe(4); // After 4 history messages
    expect(input.assistantMessage.turnIndex).toBe(5);
  });

  it('skips prior context when no history is provided', async () => {
    const factExtractor = createMockFactExtractor();
    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      factExtractor,
    };

    const response = await postChat({ message: 'hello' }, deps);
    await response.text();

    const input = (factExtractor.extractFromTurn as any).mock.calls[0][0] as FactExtractionInput;
    expect(input.priorContext).toBeUndefined();
    expect(input.userMessage.turnIndex).toBe(0);
    expect(input.assistantMessage.turnIndex).toBe(1);
  });
});

describe('POST /chat — ingestion trace: IngestionHandler mode', () => {
  it('emits ingestion start + complete traces via IngestionHandler', async () => {
    const mockIngestionHandler = {
      ingest: vi.fn().mockResolvedValue({
        factCount: 3,
        facts: [
          { content: 'Fact A from handler' },
          { content: 'Fact B from handler' },
          { content: 'Fact C from handler' },
        ],
      }),
    };

    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      ingestionHandler: mockIngestionHandler,
    };

    const response = await postChat({ message: 'hello world' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionEvents = getTraceEvents(events, 'ingestion');
    expect(ingestionEvents.length).toBe(2);

    // Start trace
    const startTrace = ingestionEvents[0]!.data as TraceEvent;
    expect(startTrace.status).toBe('start');
    expect((startTrace.data as any).mode).toBe('handler');

    // Complete trace
    const completeTrace = ingestionEvents[1]!.data as TraceEvent;
    expect(completeTrace.status).toBe('complete');
    expect(completeTrace.durationMs).toBeGreaterThanOrEqual(0);
    const data = completeTrace.data as any;
    expect(data.factCount).toBe(3);
    expect(data.facts).toHaveLength(3);
    expect(data.facts[0].content).toBe('Fact A from handler');
  });

  it('IngestionHandler takes precedence over FactExtractor when both provided', async () => {
    const mockIngestionHandler = {
      ingest: vi.fn().mockResolvedValue({ factCount: 1, facts: [{ content: 'from handler' }] }),
    };
    const factExtractor = createMockFactExtractor();

    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      ingestionHandler: mockIngestionHandler,
      factExtractor,
    };

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionEvents = getTraceEvents(events, 'ingestion');
    const startTrace = ingestionEvents[0]!.data as TraceEvent;
    expect((startTrace.data as any).mode).toBe('handler');

    expect(mockIngestionHandler.ingest).toHaveBeenCalledTimes(1);
    expect(factExtractor.extractFromTurn).not.toHaveBeenCalled();
  });

  it('emits ingestion error trace when IngestionHandler returns error', async () => {
    const mockIngestionHandler = {
      ingest: vi.fn().mockResolvedValue({
        factCount: 0,
        error: 'Handler extraction failed',
      }),
    };

    const deps: ChatRouterDependencies = {
      llmProvider: mockProvider,
      ingestionHandler: mockIngestionHandler,
    };

    const response = await postChat({ message: 'hello' }, deps);
    const text = await response.text();
    const events = parseSSEEvents(text);

    const ingestionEvents = getTraceEvents(events, 'ingestion');
    expect(ingestionEvents.length).toBe(2);

    const errorTrace = ingestionEvents[1]!.data as TraceEvent;
    expect(errorTrace.status).toBe('error');
    expect((errorTrace.data as any).error).toBe('Handler extraction failed');
  });
});
