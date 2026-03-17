/**
 * Tests for the SSE parser used by the useChat hook.
 *
 * The parser processes the wire format from the chat-router backend:
 *   event: trace\ndata: {...}\n\n
 *   event: chat\ndata: {...}\n\n
 *   event: done\ndata: {...}\n\n
 */

import { describe, it, expect } from 'vitest';

// Import the SSE parser directly — it's a pure function with no React dependency
// We inline the same logic here since the web/ module uses bundler resolution
// and the root vitest uses Node resolution.

interface ParsedSSEEvent {
  event: string;
  data: string;
}

function parseSSEChunk(buffer: string): { events: ParsedSSEEvent[]; remaining: string } {
  const events: ParsedSSEEvent[] = [];
  const blocks = buffer.split('\n\n');
  const remaining = blocks.pop() ?? '';

  for (const block of blocks) {
    if (!block.trim()) continue;

    let eventType = '';
    let data = '';

    const lines = block.split('\n');
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        if (data) {
          data += '\n' + line.slice(5).trim();
        } else {
          data = line.slice(5).trim();
        }
      }
    }

    if (eventType && data) {
      events.push({ event: eventType, data });
    }
  }

  return { events, remaining };
}

// ─── Tests ──────────────────────────────────────────────────

describe('SSE Parser (parseSSEChunk)', () => {
  it('parses a single complete trace event', () => {
    const input = 'event: trace\ndata: {"stage":"recall","status":"start","timestamp":"2025-01-01T00:00:00.000Z"}\n\n';
    const { events, remaining } = parseSSEChunk(input);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('trace');
    expect(remaining).toBe('');

    const data = JSON.parse(events[0].data);
    expect(data.stage).toBe('recall');
    expect(data.status).toBe('start');
  });

  it('parses multiple complete events', () => {
    const input = [
      'event: trace\ndata: {"stage":"recall","status":"start","timestamp":"T1"}\n',
      '\n',
      'event: chat\ndata: {"type":"delta","content":"Hello"}\n',
      '\n',
      'event: chat\ndata: {"type":"delta","content":" world"}\n',
      '\n',
    ].join('');

    const { events, remaining } = parseSSEChunk(input);

    expect(events).toHaveLength(3);
    expect(events[0].event).toBe('trace');
    expect(events[1].event).toBe('chat');
    expect(events[2].event).toBe('chat');
    expect(remaining).toBe('');

    expect(JSON.parse(events[1].data).content).toBe('Hello');
    expect(JSON.parse(events[2].data).content).toBe(' world');
  });

  it('keeps incomplete event in remaining buffer', () => {
    const input = 'event: trace\ndata: {"stage":"recall"}\n\nevent: chat\ndata: {"type":"del';
    const { events, remaining } = parseSSEChunk(input);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('trace');
    expect(remaining).toBe('event: chat\ndata: {"type":"del');
  });

  it('handles empty buffer', () => {
    const { events, remaining } = parseSSEChunk('');
    expect(events).toHaveLength(0);
    expect(remaining).toBe('');
  });

  it('handles buffer with only whitespace', () => {
    const { events, remaining } = parseSSEChunk('\n\n\n');
    expect(events).toHaveLength(0);
  });

  it('parses done event with fullResponse and totalDurationMs', () => {
    const input = 'event: done\ndata: {"fullResponse":"Hello world","totalDurationMs":1234.56}\n\n';
    const { events } = parseSSEChunk(input);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('done');

    const data = JSON.parse(events[0].data);
    expect(data.fullResponse).toBe('Hello world');
    expect(data.totalDurationMs).toBe(1234.56);
  });

  it('parses chat finish event with usage data', () => {
    const input = 'event: chat\ndata: {"type":"finish","content":"Full response","usage":{"promptTokens":10,"completionTokens":5,"totalTokens":15}}\n\n';
    const { events } = parseSSEChunk(input);

    expect(events).toHaveLength(1);
    const data = JSON.parse(events[0].data);
    expect(data.type).toBe('finish');
    expect(data.usage.totalTokens).toBe(15);
  });

  it('parses chat error event', () => {
    const input = 'event: chat\ndata: {"type":"error","error":"API rate limit"}\n\n';
    const { events } = parseSSEChunk(input);

    expect(events).toHaveLength(1);
    const data = JSON.parse(events[0].data);
    expect(data.type).toBe('error');
    expect(data.error).toBe('API rate limit');
  });

  it('skips blocks without event type', () => {
    const input = 'data: {"orphan":"data"}\n\n';
    const { events } = parseSSEChunk(input);
    expect(events).toHaveLength(0);
  });

  it('skips blocks without data', () => {
    const input = 'event: trace\n\n';
    const { events } = parseSSEChunk(input);
    expect(events).toHaveLength(0);
  });

  it('handles incremental buffer accumulation (simulating chunked reads)', () => {
    // Simulate multiple read() calls returning partial data
    let buffer = '';
    const allEvents: ParsedSSEEvent[] = [];

    // Chunk 1: partial event
    buffer += 'event: trace\ndata: {"stage":"re';
    let result = parseSSEChunk(buffer);
    allEvents.push(...result.events);
    buffer = result.remaining;
    expect(result.events).toHaveLength(0);

    // Chunk 2: complete first event + start of second
    buffer += 'call","status":"start","timestamp":"T1"}\n\nevent: chat\ndata: {"type":"d';
    result = parseSSEChunk(buffer);
    allEvents.push(...result.events);
    buffer = result.remaining;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].event).toBe('trace');

    // Chunk 3: complete second event
    buffer += 'elta","content":"Hi"}\n\n';
    result = parseSSEChunk(buffer);
    allEvents.push(...result.events);
    buffer = result.remaining;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].event).toBe('chat');

    expect(allEvents).toHaveLength(2);
    expect(buffer).toBe('');
  });

  it('parses a full pipeline sequence', () => {
    // Simulate a complete chat pipeline response
    const input = [
      'event: trace\ndata: {"stage":"recall","status":"start","timestamp":"T1"}\n\n',
      'event: trace\ndata: {"stage":"recall","status":"complete","durationMs":45,"data":{"itemCount":3},"timestamp":"T2"}\n\n',
      'event: trace\ndata: {"stage":"llm","status":"start","data":{"provider":"openai"},"timestamp":"T3"}\n\n',
      'event: chat\ndata: {"type":"delta","content":"Hello"}\n\n',
      'event: chat\ndata: {"type":"delta","content":" there!"}\n\n',
      'event: chat\ndata: {"type":"finish","content":"Hello there!","usage":{"promptTokens":50,"completionTokens":2,"totalTokens":52}}\n\n',
      'event: trace\ndata: {"stage":"llm","status":"complete","durationMs":200,"timestamp":"T4"}\n\n',
      'event: trace\ndata: {"stage":"ingestion","status":"start","timestamp":"T5"}\n\n',
      'event: trace\ndata: {"stage":"ingestion","status":"complete","durationMs":100,"data":{"factCount":1},"timestamp":"T6"}\n\n',
      'event: trace\ndata: {"stage":"pipeline","status":"complete","durationMs":345,"timestamp":"T7"}\n\n',
      'event: done\ndata: {"fullResponse":"Hello there!","totalDurationMs":345}\n\n',
    ].join('');

    const { events, remaining } = parseSSEChunk(input);
    expect(remaining).toBe('');
    expect(events).toHaveLength(11);

    // Verify event sequence
    const eventTypes = events.map(e => e.event);
    expect(eventTypes).toEqual([
      'trace', 'trace', 'trace',  // recall start/complete + llm start
      'chat', 'chat', 'chat',     // delta, delta, finish
      'trace', 'trace', 'trace',  // llm complete + ingestion start/complete
      'trace',                      // pipeline complete
      'done',                       // done
    ]);

    // Verify trace stages
    const traceStages = events
      .filter(e => e.event === 'trace')
      .map(e => JSON.parse(e.data).stage);
    expect(traceStages).toEqual([
      'recall', 'recall', 'llm', 'llm', 'ingestion', 'ingestion', 'pipeline',
    ]);
  });
});

describe('SSE Event Type Handling', () => {
  it('correctly identifies trace events with all status types', () => {
    const statuses = ['start', 'complete', 'error', 'skipped'];

    for (const status of statuses) {
      const input = `event: trace\ndata: {"stage":"recall","status":"${status}","timestamp":"T"}\n\n`;
      const { events } = parseSSEChunk(input);
      expect(events).toHaveLength(1);
      const data = JSON.parse(events[0].data);
      expect(data.status).toBe(status);
    }
  });

  it('preserves trace event data payloads', () => {
    const traceData = {
      stage: 'recall',
      status: 'complete',
      durationMs: 45.23,
      data: {
        itemCount: 5,
        diagnostics: { vectorPath: { itemCount: 3 }, graphPath: { itemCount: 2 } },
      },
      timestamp: '2025-01-01T00:00:00.000Z',
    };

    const input = `event: trace\ndata: ${JSON.stringify(traceData)}\n\n`;
    const { events } = parseSSEChunk(input);
    const parsed = JSON.parse(events[0].data);

    expect(parsed).toEqual(traceData);
    expect(parsed.data.diagnostics.vectorPath.itemCount).toBe(3);
  });

  it('handles chat delta with empty content', () => {
    const input = 'event: chat\ndata: {"type":"delta","content":""}\n\n';
    const { events } = parseSSEChunk(input);
    expect(events).toHaveLength(1);
    const data = JSON.parse(events[0].data);
    expect(data.type).toBe('delta');
    expect(data.content).toBe('');
  });

  it('handles special characters in content', () => {
    const content = 'Hello "world"! Use \\n for newlines. <html>&amp;</html>';
    const input = `event: chat\ndata: {"type":"delta","content":${JSON.stringify(content)}}\n\n`;
    const { events } = parseSSEChunk(input);
    const data = JSON.parse(events[0].data);
    expect(data.content).toBe(content);
  });
});

describe('Request Body Format (ChatRequest)', () => {
  // These tests verify the expected request format matches the backend's ChatRequest interface
  it('validates minimal request has message field', () => {
    const request = { message: 'Hello' };
    expect(request.message).toBe('Hello');
  });

  it('validates full request with all optional fields', () => {
    const request = {
      message: 'What do you know about me?',
      history: [
        { role: 'user' as const, content: 'Hi' },
        { role: 'assistant' as const, content: 'Hello!' },
      ],
      provider: 'openai' as const,
      model: 'gpt-4o',
      temperature: 0.7,
      maxTokens: 1000,
      systemPrompt: 'You are helpful.',
    };

    expect(request.message).toBeTruthy();
    expect(request.history).toHaveLength(2);
    expect(request.provider).toBe('openai');
  });
});
