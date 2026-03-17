/**
 * AC 5: SSE 스트림에 event:chat 타입으로 LLM 응답이 토큰 단위 스트리밍된다
 *
 * Validates:
 * - event:chat with type:"delta" emitted per token from LLM stream
 * - event:chat with type:"finish" emitted once with full accumulated text + usage
 * - event:chat with type:"error" emitted on LLM errors
 * - Token-level granularity: each delta carries exactly one token/chunk
 * - Correct SSE wire format: "event: chat\ndata: {...}\n\n"
 * - Streaming fallback: non-streaming provider still emits chat events
 * - Chat events appear between trace:llm:start and trace:llm:complete
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createChatRouter,
  formatSSE,
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

// ─── Mock Providers ──────────────────────────────────────

/** Mock provider that yields controllable token-level stream events. */
class TokenStreamProvider implements LLMProvider {
  readonly name = 'token-stream-mock';
  public streamCalls: LLMStreamRequest[] = [];
  public events: LLMStreamEvent[] = [];

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    return { content: 'fallback' };
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    this.streamCalls.push(request);
    for (const event of this.events) {
      yield event;
    }
  }
}

/** Provider without stream() — forces complete() fallback path. */
class NonStreamProvider implements LLMProvider {
  readonly name = 'non-stream-mock';
  public response = 'buffered text';
  public usage = { promptTokens: 20, completionTokens: 10, totalTokens: 30 };

  async complete(): Promise<LLMCompletionResponse> {
    return { content: this.response, usage: this.usage };
  }
}

// ─── Helpers ──────────────────────────────────────────────

function parseSSEEvents(text: string): Array<{ event: string; data: unknown; raw: string }> {
  const events: Array<{ event: string; data: unknown; raw: string }> = [];
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
        events.push({ event, data: JSON.parse(data), raw: data });
      } catch {
        events.push({ event, data, raw: data });
      }
    }
  }
  return events;
}

async function postChat(
  body: unknown,
  deps: ChatRouterDependencies,
): Promise<{ response: Response; text: string; events: ReturnType<typeof parseSSEEvents> }> {
  const app = createChatRouter(deps);
  const req = new Request('http://localhost/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await app.fetch(req);
  const text = await response.text();
  return { response, text, events: parseSSEEvents(text) };
}

// ─── Tests ───────────────────────────────────────────────

describe('AC 5 — event:chat SSE token-level streaming', () => {
  let provider: TokenStreamProvider;
  let deps: ChatRouterDependencies;

  beforeEach(() => {
    provider = new TokenStreamProvider();
    deps = { llmProvider: provider };
  });

  // ── Token-level delta streaming ──

  describe('token-level delta events', () => {
    it('emits one event:chat per delta token from the LLM stream', async () => {
      provider.events = [
        { type: 'delta', content: 'Hello' },
        { type: 'delta', content: ' ' },
        { type: 'delta', content: 'world' },
        { type: 'delta', content: '!' },
        { type: 'finish', content: 'Hello world!' },
      ];

      const { events } = await postChat({ message: 'hi' }, deps);

      const deltas = events.filter(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'delta',
      );
      expect(deltas).toHaveLength(4);
      expect((deltas[0]!.data as ChatEvent).content).toBe('Hello');
      expect((deltas[1]!.data as ChatEvent).content).toBe(' ');
      expect((deltas[2]!.data as ChatEvent).content).toBe('world');
      expect((deltas[3]!.data as ChatEvent).content).toBe('!');
    });

    it('preserves exact token content — no merging or splitting', async () => {
      // Simulate realistic small token chunks
      const tokens = ['The', ' quick', ' brown', ' fox'];
      provider.events = [
        ...tokens.map((t) => ({ type: 'delta' as const, content: t })),
        { type: 'finish', content: tokens.join('') },
      ];

      const { events } = await postChat({ message: 'test' }, deps);

      const deltas = events.filter(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'delta',
      );
      expect(deltas).toHaveLength(tokens.length);
      deltas.forEach((d, i) => {
        expect((d.data as ChatEvent).content).toBe(tokens[i]);
      });
    });

    it('handles single-token response', async () => {
      provider.events = [
        { type: 'delta', content: 'Yes' },
        { type: 'finish', content: 'Yes' },
      ];

      const { events } = await postChat({ message: 'agree?' }, deps);

      const deltas = events.filter(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'delta',
      );
      expect(deltas).toHaveLength(1);
      expect((deltas[0]!.data as ChatEvent).content).toBe('Yes');
    });

    it('handles many tokens (simulates long response)', async () => {
      const tokenCount = 50;
      const tokens = Array.from({ length: tokenCount }, (_, i) => `tok${i} `);
      provider.events = [
        ...tokens.map((t) => ({ type: 'delta' as const, content: t })),
        { type: 'finish', content: tokens.join('') },
      ];

      const { events } = await postChat({ message: 'long' }, deps);

      const deltas = events.filter(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'delta',
      );
      expect(deltas).toHaveLength(tokenCount);
    });
  });

  // ── Finish event ──

  describe('finish event', () => {
    it('emits event:chat with type:"finish" containing full accumulated text', async () => {
      provider.events = [
        { type: 'delta', content: 'Hello' },
        { type: 'delta', content: ' world' },
        {
          type: 'finish',
          content: 'Hello world',
          usage: { promptTokens: 15, completionTokens: 8, totalTokens: 23 },
        },
      ];

      const { events } = await postChat({ message: 'hi' }, deps);

      const finish = events.find(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'finish',
      );
      expect(finish).toBeDefined();

      const data = finish!.data as ChatEvent;
      expect(data.content).toBe('Hello world');
      expect(data.usage).toEqual({
        promptTokens: 15,
        completionTokens: 8,
        totalTokens: 23,
      });
    });

    it('emits exactly one finish event per request', async () => {
      provider.events = [
        { type: 'delta', content: 'a' },
        { type: 'delta', content: 'b' },
        { type: 'finish', content: 'ab' },
      ];

      const { events } = await postChat({ message: 'test' }, deps);

      const finishes = events.filter(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'finish',
      );
      expect(finishes).toHaveLength(1);
    });

    it('finish event appears after all delta events', async () => {
      provider.events = [
        { type: 'delta', content: 'x' },
        { type: 'delta', content: 'y' },
        { type: 'finish', content: 'xy' },
      ];

      const { events } = await postChat({ message: 'test' }, deps);

      const chatEvents = events.filter((e) => e.event === 'chat');
      const types = chatEvents.map((e) => (e.data as ChatEvent).type);
      const lastDeltaIdx = types.lastIndexOf('delta');
      const finishIdx = types.indexOf('finish');
      expect(finishIdx).toBeGreaterThan(lastDeltaIdx);
    });
  });

  // ── Error events ──

  describe('error events', () => {
    it('emits event:chat with type:"error" when LLM yields an error', async () => {
      provider.events = [
        { type: 'delta', content: 'partial' },
        { type: 'error', error: 'Rate limit exceeded' },
      ];

      const { events } = await postChat({ message: 'hi' }, deps);

      const errEvt = events.find(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'error',
      );
      expect(errEvt).toBeDefined();
      expect((errEvt!.data as ChatEvent).error).toBe('Rate limit exceeded');
    });

    it('emits event:chat error when stream() throws', async () => {
      // Override to throw
      provider.stream = async function* () {
        throw new Error('Connection refused');
      };

      const { events } = await postChat({ message: 'hi' }, deps);

      const errEvt = events.find(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'error',
      );
      expect(errEvt).toBeDefined();
      expect((errEvt!.data as ChatEvent).error).toBe('Connection refused');
    });

    it('stream continues to emit done event after error', async () => {
      provider.events = [{ type: 'error', error: 'fail' }];

      const { events } = await postChat({ message: 'hi' }, deps);

      const doneEvt = events.find((e) => e.event === 'done');
      expect(doneEvt).toBeDefined();
    });
  });

  // ── SSE wire format ──

  describe('SSE wire format for chat events', () => {
    it('chat delta event follows "event: chat\\ndata: {...}\\n\\n" format', async () => {
      provider.events = [
        { type: 'delta', content: 'test' },
        { type: 'finish', content: 'test' },
      ];

      const { text } = await postChat({ message: 'hi' }, deps);

      // Should contain the exact SSE format
      expect(text).toContain('event: chat\ndata: {"type":"delta","content":"test"}\n\n');
    });

    it('chat finish event follows SSE format with usage data', async () => {
      provider.events = [
        {
          type: 'finish',
          content: 'done',
          usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        },
      ];

      const { text } = await postChat({ message: 'hi' }, deps);

      // Verify it can be parsed back
      const chatFinish = parseSSEEvents(text).find(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'finish',
      );
      expect(chatFinish).toBeDefined();
      const data = chatFinish!.data as ChatEvent;
      expect(data.content).toBe('done');
      expect(data.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    });

    it('all chat events use event name "chat" (not "message" or other)', async () => {
      provider.events = [
        { type: 'delta', content: 'a' },
        { type: 'finish', content: 'a' },
      ];

      const { events } = await postChat({ message: 'hi' }, deps);

      const chatEvents = events.filter(
        (e) => (e.data as ChatEvent).type === 'delta' || (e.data as ChatEvent).type === 'finish',
      );
      for (const evt of chatEvents) {
        expect(evt.event).toBe('chat');
      }
    });
  });

  // ── Event ordering relative to trace events ──

  describe('chat events positioned between llm:start and llm:complete traces', () => {
    it('all chat deltas appear after trace:llm:start and before trace:llm:complete', async () => {
      provider.events = [
        { type: 'delta', content: 'a' },
        { type: 'delta', content: 'b' },
        { type: 'finish', content: 'ab' },
      ];

      const { events } = await postChat({ message: 'test' }, deps);

      const sequence = events.map((e, idx) => {
        if (e.event === 'trace') {
          const t = e.data as TraceEvent;
          return { idx, key: `trace:${t.stage}:${t.status}` };
        }
        if (e.event === 'chat') {
          return { idx, key: `chat:${(e.data as ChatEvent).type}` };
        }
        return { idx, key: e.event };
      });

      const llmStart = sequence.find((s) => s.key === 'trace:llm:start');
      const llmComplete = sequence.find((s) => s.key === 'trace:llm:complete');
      const chatDeltas = sequence.filter((s) => s.key === 'chat:delta');
      const chatFinish = sequence.find((s) => s.key === 'chat:finish');

      expect(llmStart).toBeDefined();
      expect(llmComplete).toBeDefined();

      for (const delta of chatDeltas) {
        expect(delta.idx).toBeGreaterThan(llmStart!.idx);
        expect(delta.idx).toBeLessThan(llmComplete!.idx);
      }

      expect(chatFinish!.idx).toBeGreaterThan(llmStart!.idx);
      expect(chatFinish!.idx).toBeLessThan(llmComplete!.idx);
    });
  });

  // ── Non-streaming fallback ──

  describe('non-streaming provider fallback emits chat events', () => {
    it('emits chat delta + finish even when provider lacks stream()', async () => {
      const nonStream = new NonStreamProvider();
      const fallbackDeps: ChatRouterDependencies = { llmProvider: nonStream };

      const { events } = await postChat({ message: 'hello' }, fallbackDeps);

      const delta = events.find(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'delta',
      );
      expect(delta).toBeDefined();
      expect((delta!.data as ChatEvent).content).toBe('buffered text');

      const finish = events.find(
        (e) => e.event === 'chat' && (e.data as ChatEvent).type === 'finish',
      );
      expect(finish).toBeDefined();
      expect((finish!.data as ChatEvent).content).toBe('buffered text');
      expect((finish!.data as ChatEvent).usage).toEqual({
        promptTokens: 20,
        completionTokens: 10,
        totalTokens: 30,
      });
    });
  });

  // ── done event carries full response ──

  describe('done event carries full streamed response', () => {
    it('done event fullResponse matches accumulated deltas', async () => {
      provider.events = [
        { type: 'delta', content: 'Hello' },
        { type: 'delta', content: ' world' },
        { type: 'finish', content: 'Hello world' },
      ];

      const { events } = await postChat({ message: 'hi' }, deps);

      const doneEvt = events.find((e) => e.event === 'done');
      expect(doneEvt).toBeDefined();
      expect((doneEvt!.data as DoneEvent).fullResponse).toBe('Hello world');
      expect(typeof (doneEvt!.data as DoneEvent).totalDurationMs).toBe('number');
    });
  });
});
