/**
 * Sub-AC 2-2: LLM 호출 및 SSE 이벤트 직렬화 로직 검증
 *
 * Validates:
 * - Request body messages parsing (message + history → LLMChatMessage[])
 * - LLM streaming API invocation with correct parameters
 * - Delta tokens converted to SSE `event: chat\ndata: {"type":"delta","content":...}\n\n`
 * - Finish event with full response + usage
 * - [DONE] terminal event sent on completion
 * - SSE wire format fidelity
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createChatRouter,
  formatSSE,
  safeSerialize,
  type ChatRouterDependencies,
  type TraceEvent,
  type ChatEvent,
  type DoneEvent,
} from '../src/chat/chat-router.js';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamRequest,
  LLMStreamEvent,
  LLMChatMessage,
} from '../src/extraction/llm-provider.js';

// ─── Mock LLM Provider ──────────────────────────────────

class MockStreamLLM implements LLMProvider {
  readonly name = 'mock-stream';
  public streamCalls: LLMStreamRequest[] = [];
  public events: LLMStreamEvent[] = [];

  async complete(_req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    return { content: 'fallback' };
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    this.streamCalls.push(request);
    for (const event of this.events) {
      yield event;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────

interface ParsedSSE {
  event: string;
  data: unknown;
  raw: string;
}

function parseSSEText(text: string): ParsedSSE[] {
  const results: ParsedSSE[] = [];
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (event && data) {
      try {
        results.push({ event, data: JSON.parse(data), raw: data });
      } catch {
        results.push({ event, data, raw: data });
      }
    }
  }
  return results;
}

async function sendChat(
  body: unknown,
  deps: ChatRouterDependencies,
): Promise<{ status: number; text: string; events: ParsedSSE[] }> {
  const app = createChatRouter(deps);
  const req = new Request('http://localhost/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await app.fetch(req);
  const text = await res.text();
  return { status: res.status, text, events: parseSSEText(text) };
}

// ─── Tests ───────────────────────────────────────────────

describe('Sub-AC 2-2: LLM 호출 및 SSE 이벤트 직렬화', () => {
  let provider: MockStreamLLM;
  let deps: ChatRouterDependencies;

  beforeEach(() => {
    provider = new MockStreamLLM();
    deps = { llmProvider: provider };
  });

  // ── 1. Request body messages parsing ──

  describe('messages parsing from request body', () => {
    it('parses single message into LLMChatMessage array', async () => {
      provider.events = [
        { type: 'delta', content: 'ok' },
        { type: 'finish', content: 'ok' },
      ];

      await sendChat({ message: 'hello' }, deps);

      expect(provider.streamCalls).toHaveLength(1);
      const call = provider.streamCalls[0]!;
      expect(call.messages).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('parses history + current message into ordered LLMChatMessage array', async () => {
      provider.events = [
        { type: 'delta', content: 'reply' },
        { type: 'finish', content: 'reply' },
      ];

      await sendChat(
        {
          message: 'follow-up question',
          history: [
            { role: 'user', content: 'first question' },
            { role: 'assistant', content: 'first answer' },
          ],
        },
        deps,
      );

      const call = provider.streamCalls[0]!;
      expect(call.messages).toEqual([
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'follow-up question' },
      ]);
    });

    it('passes system prompt to LLM stream request', async () => {
      provider.events = [{ type: 'finish', content: '' }];

      await sendChat({ message: 'hi', systemPrompt: 'Be concise.' }, deps);

      const call = provider.streamCalls[0]!;
      expect(call.system).toContain('Be concise.');
    });

    it('passes temperature and maxTokens from request body', async () => {
      provider.events = [{ type: 'finish', content: '' }];

      await sendChat({ message: 'hi', temperature: 0.3, maxTokens: 200 }, deps);

      const call = provider.streamCalls[0]!;
      expect(call.temperature).toBe(0.3);
      expect(call.maxTokens).toBe(200);
    });
  });

  // ── 2. Delta token → SSE event conversion ──

  describe('delta tokens to SSE data events', () => {
    it('converts each LLM delta to event:chat with type:"delta"', async () => {
      provider.events = [
        { type: 'delta', content: 'Hello' },
        { type: 'delta', content: ' ' },
        { type: 'delta', content: 'world' },
        { type: 'finish', content: 'Hello world' },
      ];

      const { events } = await sendChat({ message: 'hi' }, deps);

      const deltas = events.filter(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'delta',
      );
      expect(deltas).toHaveLength(3);
      expect((deltas[0]!.data as ChatEvent).content).toBe('Hello');
      expect((deltas[1]!.data as ChatEvent).content).toBe(' ');
      expect((deltas[2]!.data as ChatEvent).content).toBe('world');
    });

    it('produces correct SSE wire format: event: chat\\ndata: {"type":"delta","content":"..."}\n\n', async () => {
      provider.events = [
        { type: 'delta', content: 'test' },
        { type: 'finish', content: 'test' },
      ];

      const { text } = await sendChat({ message: 'hi' }, deps);

      // Exact wire format check
      expect(text).toContain('event: chat\ndata: {"type":"delta","content":"test"}\n\n');
    });

    it('handles special characters in delta content (quotes, newlines, unicode)', async () => {
      provider.events = [
        { type: 'delta', content: 'He said "hi"\nNext line' },
        { type: 'delta', content: ' — emoji: 🎉' },
        { type: 'finish', content: 'He said "hi"\nNext line — emoji: 🎉' },
      ];

      const { events } = await sendChat({ message: 'hi' }, deps);

      const deltas = events.filter(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'delta',
      );
      expect(deltas).toHaveLength(2);
      expect((deltas[0]!.data as ChatEvent).content).toBe('He said "hi"\nNext line');
      expect((deltas[1]!.data as ChatEvent).content).toBe(' — emoji: 🎉');
    });
  });

  // ── 3. Finish event ──

  describe('finish event with full response and usage', () => {
    it('emits event:chat with type:"finish" containing accumulated content', async () => {
      provider.events = [
        { type: 'delta', content: 'A' },
        { type: 'delta', content: 'B' },
        {
          type: 'finish',
          content: 'AB',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        },
      ];

      const { events } = await sendChat({ message: 'hi' }, deps);

      const finish = events.find(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'finish',
      );
      expect(finish).toBeDefined();
      const data = finish!.data as ChatEvent;
      expect(data.content).toBe('AB');
      expect(data.usage).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
    });
  });

  // ── 4. [DONE] terminal event ──

  describe('[DONE] terminal event', () => {
    it('sends event:done as the final SSE event', async () => {
      provider.events = [
        { type: 'delta', content: 'Hello' },
        { type: 'finish', content: 'Hello' },
      ];

      const { events } = await sendChat({ message: 'hi' }, deps);

      // Last event must be "done"
      const lastEvent = events[events.length - 1]!;
      expect(lastEvent.event).toBe('done');
    });

    it('done event contains fullResponse and totalDurationMs', async () => {
      provider.events = [
        { type: 'delta', content: 'Hello world' },
        { type: 'finish', content: 'Hello world' },
      ];

      const { events } = await sendChat({ message: 'hi' }, deps);

      const doneEvt = events.find((e) => e.event === 'done')!;
      const data = doneEvt.data as DoneEvent;
      expect(data.fullResponse).toBe('Hello world');
      expect(typeof data.totalDurationMs).toBe('number');
      expect(data.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('done event includes all collected trace events for timeline', async () => {
      provider.events = [
        { type: 'delta', content: 'x' },
        { type: 'finish', content: 'x' },
      ];

      const { events } = await sendChat({ message: 'hi' }, deps);

      const doneEvt = events.find((e) => e.event === 'done')!;
      const data = doneEvt.data as DoneEvent;
      expect(Array.isArray(data.traceEvents)).toBe(true);
      expect(data.traceEvents!.length).toBeGreaterThanOrEqual(1);

      // Should include pipeline:complete trace
      const pipelineTrace = data.traceEvents!.find(
        (t) => t.stage === 'pipeline' && t.status === 'complete',
      );
      expect(pipelineTrace).toBeDefined();
    });

    it('done event is sent even when LLM errors occur', async () => {
      provider.events = [{ type: 'error', error: 'API failure' }];

      const { events } = await sendChat({ message: 'hi' }, deps);

      const doneEvt = events.find((e) => e.event === 'done');
      expect(doneEvt).toBeDefined();
    });
  });

  // ── 5. Complete SSE event flow ──

  describe('complete SSE event flow', () => {
    it('produces correct event sequence: trace(recall) → trace(context-build) → trace(llm:start) → chat(delta)* → chat(finish) → trace(llm:complete) → trace(ingestion) → trace(pipeline:complete) → done', async () => {
      provider.events = [
        { type: 'delta', content: 'A' },
        { type: 'delta', content: 'B' },
        { type: 'finish', content: 'AB' },
      ];

      const { events } = await sendChat({ message: 'hi' }, deps);

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

      // Verify key ordering constraints
      const llmStartIdx = sequence.indexOf('trace:llm:start');
      const firstDelta = sequence.indexOf('chat:delta');
      const finishIdx = sequence.indexOf('chat:finish');
      const llmCompleteIdx = sequence.indexOf('trace:llm:complete');
      const doneIdx = sequence.indexOf('done');

      expect(llmStartIdx).toBeLessThan(firstDelta);
      expect(firstDelta).toBeLessThan(finishIdx);
      expect(finishIdx).toBeLessThan(llmCompleteIdx);
      expect(llmCompleteIdx).toBeLessThan(doneIdx);
      expect(doneIdx).toBe(events.length - 1); // done is always last
    });
  });

  // ── 6. formatSSE / safeSerialize unit tests ──

  describe('SSE serialization helpers', () => {
    it('formatSSE produces "event: <name>\\ndata: <json>\\n\\n"', () => {
      const result = formatSSE('chat', { type: 'delta', content: 'token' });
      expect(result).toBe('event: chat\ndata: {"type":"delta","content":"token"}\n\n');
    });

    it('formatSSE handles string data without double-encoding', () => {
      const result = formatSSE('done', '[DONE]');
      expect(result).toBe('event: done\ndata: [DONE]\n\n');
    });

    it('safeSerialize handles circular references', () => {
      const obj: any = { a: 1 };
      obj.self = obj;
      const result = safeSerialize(obj);
      expect(result).toContain('"a":1');
      expect(result).toContain('[Circular]');
    });

    it('safeSerialize handles BigInt values', () => {
      const obj = { big: BigInt(12345678901234567890n) };
      const result = safeSerialize(obj);
      expect(result).toContain('12345678901234567890');
    });

    it('safeSerialize truncates oversized payloads', () => {
      const bigStr = 'x'.repeat(100_000);
      const result = safeSerialize({ data: bigStr });
      const parsed = JSON.parse(result);
      expect(parsed._truncated).toBe(true);
    });
  });
});
