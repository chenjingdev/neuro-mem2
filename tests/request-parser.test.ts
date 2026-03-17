/**
 * Tests for request-parser — extracting user messages from LLM API request bodies.
 */

import { describe, it, expect } from 'vitest';
import {
  parseRequest,
  detectApiFormat,
  extractOpenAIContent,
  extractLatestUserQuery,
} from '../src/proxy/request-parser.js';
import type { ParsedMessage } from '../src/proxy/request-parser.js';

// ─── Format Detection ────────────────────────────────────

describe('detectApiFormat', () => {
  it('detects OpenAI format (messages array without max_tokens)', () => {
    expect(detectApiFormat({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
    })).toBe('openai');
  });

  it('detects Anthropic format (messages + max_tokens)', () => {
    expect(detectApiFormat({
      model: 'claude-3-opus',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    })).toBe('anthropic');
  });

  it('returns generic for null/undefined', () => {
    expect(detectApiFormat(null)).toBe('generic');
    expect(detectApiFormat(undefined)).toBe('generic');
  });

  it('returns generic for non-object', () => {
    expect(detectApiFormat('string')).toBe('generic');
    expect(detectApiFormat(42)).toBe('generic');
  });

  it('returns generic for empty object', () => {
    expect(detectApiFormat({})).toBe('generic');
  });
});

// ─── OpenAI Content Extraction ───────────────────────────

describe('extractOpenAIContent', () => {
  it('extracts string content', () => {
    expect(extractOpenAIContent('Hello world')).toBe('Hello world');
  });

  it('handles null content', () => {
    expect(extractOpenAIContent(null)).toBe('');
  });

  it('handles undefined content', () => {
    expect(extractOpenAIContent(undefined as any)).toBe('');
  });

  it('extracts from content array (multimodal)', () => {
    const content = [
      { type: 'text', text: 'Describe this image:' },
      { type: 'image_url', image_url: { url: 'data:...' } },
      { type: 'text', text: 'What do you see?' },
    ];
    expect(extractOpenAIContent(content)).toBe('Describe this image:\nWhat do you see?');
  });

  it('filters non-text parts from content array', () => {
    const content = [
      { type: 'image_url', image_url: { url: 'data:...' } },
    ];
    expect(extractOpenAIContent(content)).toBe('');
  });
});

// ─── OpenAI Request Parsing ──────────────────────────────

describe('parseRequest — OpenAI format', () => {
  it('parses basic OpenAI chat completion request', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is TypeScript?' },
      ],
    };

    const result = parseRequest(body);

    expect(result.format).toBe('openai');
    expect(result.model).toBe('gpt-4');
    expect(result.stream).toBe(false);
    expect(result.systemPrompt).toBe('You are a helpful assistant.');
    expect(result.latestUserMessage).toBe('What is TypeScript?');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.', index: 0 });
    expect(result.messages[1]).toEqual({ role: 'user', content: 'What is TypeScript?', index: 1 });
  });

  it('extracts latest user message from multi-turn conversation', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'What is Rust?' },
        { role: 'assistant', content: 'Rust is a systems programming language.' },
        { role: 'user', content: 'How does its borrow checker work?' },
      ],
    };

    const result = parseRequest(body);
    expect(result.latestUserMessage).toBe('How does its borrow checker work?');
    expect(result.messages).toHaveLength(5);
  });

  it('handles streaming request', () => {
    const body = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    };

    const result = parseRequest(body);
    expect(result.stream).toBe(true);
  });

  it('handles multimodal content array', () => {
    const body = {
      model: 'gpt-4-vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
          ],
        },
      ],
    };

    const result = parseRequest(body);
    expect(result.latestUserMessage).toBe('What is in this image?');
  });

  it('normalizes developer role to system', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'developer', content: 'Be helpful' },
        { role: 'user', content: 'Hi' },
      ],
    };

    const result = parseRequest(body);
    expect(result.messages[0]!.role).toBe('system');
  });

  it('normalizes tool/function roles to assistant', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Call a function' },
        { role: 'tool', content: '{"result": 42}' },
        { role: 'user', content: 'What did you get?' },
      ],
    };

    const result = parseRequest(body);
    expect(result.messages[1]!.role).toBe('assistant');
    expect(result.latestUserMessage).toBe('What did you get?');
  });

  it('returns null latestUserMessage when no user messages', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'System prompt' },
      ],
    };

    const result = parseRequest(body);
    expect(result.latestUserMessage).toBeNull();
  });
});

// ─── Anthropic Request Parsing ───────────────────────────

describe('parseRequest — Anthropic format', () => {
  it('parses basic Anthropic messages request', () => {
    const body = {
      model: 'claude-3-opus-20240229',
      max_tokens: 1024,
      system: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: 'What is TypeScript?' },
      ],
    };

    const result = parseRequest(body);

    expect(result.format).toBe('anthropic');
    expect(result.model).toBe('claude-3-opus-20240229');
    expect(result.systemPrompt).toBe('You are a helpful assistant.');
    expect(result.latestUserMessage).toBe('What is TypeScript?');
    expect(result.messages).toHaveLength(1);
  });

  it('handles system as content block array', () => {
    const body = {
      model: 'claude-3-opus',
      max_tokens: 1024,
      system: [
        { type: 'text', text: 'Part 1 of system prompt.' },
        { type: 'text', text: 'Part 2 of system prompt.' },
      ],
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    };

    const result = parseRequest(body);
    expect(result.systemPrompt).toBe('Part 1 of system prompt.\nPart 2 of system prompt.');
  });

  it('handles content block array in messages', () => {
    const body = {
      model: 'claude-3-opus',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this:' },
            { type: 'image', source: { type: 'base64', data: '...' } },
          ],
        },
      ],
    };

    const result = parseRequest(body);
    expect(result.latestUserMessage).toBe('Describe this:');
  });

  it('parses multi-turn Anthropic conversation', () => {
    const body = {
      model: 'claude-3-opus',
      max_tokens: 2048,
      messages: [
        { role: 'user', content: 'What is Rust?' },
        { role: 'assistant', content: 'Rust is a systems language.' },
        { role: 'user', content: 'Tell me about its memory model.' },
      ],
    };

    const result = parseRequest(body);
    expect(result.latestUserMessage).toBe('Tell me about its memory model.');
    expect(result.messages).toHaveLength(3);
  });

  it('handles streaming Anthropic request', () => {
    const body = {
      model: 'claude-3-opus',
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = parseRequest(body);
    expect(result.stream).toBe(true);
  });

  it('handles null system prompt', () => {
    const body = {
      model: 'claude-3-opus',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = parseRequest(body);
    expect(result.systemPrompt).toBeNull();
  });
});

// ─── Generic Format ──────────────────────────────────────

describe('parseRequest — generic format', () => {
  it('returns empty result for unrecognized format', () => {
    const result = parseRequest({ prompt: 'Hello', temperature: 0.7 });

    expect(result.format).toBe('generic');
    expect(result.messages).toHaveLength(0);
    expect(result.latestUserMessage).toBeNull();
    expect(result.rawBody).toEqual({ prompt: 'Hello', temperature: 0.7 });
  });
});

// ─── Config Options ──────────────────────────────────────

describe('parseRequest — config options', () => {
  it('uses forceFormat to override detection', () => {
    const body = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    };

    // This body would normally be detected as Anthropic, but we force OpenAI
    const result = parseRequest(body, { forceFormat: 'openai' });
    expect(result.format).toBe('openai');
  });

  it('uses customExtractor when provided', () => {
    const body = { prompt: 'Custom format', max_length: 100 };

    const result = parseRequest(body, {
      customExtractor: (b) => {
        const obj = b as Record<string, unknown>;
        if (typeof obj.prompt === 'string') {
          return {
            format: 'generic',
            messages: [{ role: 'user' as const, content: obj.prompt as string, index: 0 }],
            latestUserMessage: obj.prompt as string,
            systemPrompt: null,
            model: null,
            stream: false,
            rawBody: b,
          };
        }
        return null;
      },
    });

    expect(result.latestUserMessage).toBe('Custom format');
    expect(result.messages).toHaveLength(1);
  });

  it('concatenates multiple user messages with maxQueryMessages > 1', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'I am working on a Rust project.' },
        { role: 'assistant', content: 'How can I help?' },
        { role: 'user', content: 'How does the borrow checker work?' },
      ],
    };

    const result = parseRequest(body, { maxQueryMessages: 2 });
    expect(result.latestUserMessage).toBe(
      'I am working on a Rust project.\nHow does the borrow checker work?'
    );
  });
});

// ─── extractLatestUserQuery ──────────────────────────────

describe('extractLatestUserQuery', () => {
  const messages: ParsedMessage[] = [
    { role: 'system', content: 'You are helpful', index: 0 },
    { role: 'user', content: 'First question', index: 1 },
    { role: 'assistant', content: 'First answer', index: 2 },
    { role: 'user', content: 'Second question', index: 3 },
    { role: 'assistant', content: 'Second answer', index: 4 },
    { role: 'user', content: 'Third question', index: 5 },
  ];

  it('returns the latest user message by default', () => {
    expect(extractLatestUserQuery(messages)).toBe('Third question');
  });

  it('concatenates last N user messages', () => {
    expect(extractLatestUserQuery(messages, 2)).toBe('Second question\nThird question');
  });

  it('concatenates all user messages when maxMessages exceeds count', () => {
    expect(extractLatestUserQuery(messages, 100)).toBe(
      'First question\nSecond question\nThird question'
    );
  });

  it('returns null for empty array', () => {
    expect(extractLatestUserQuery([])).toBeNull();
  });

  it('skips whitespace-only messages', () => {
    const msgs: ParsedMessage[] = [
      { role: 'user', content: '   ', index: 0 },
      { role: 'user', content: 'Real message', index: 1 },
    ];
    expect(extractLatestUserQuery(msgs)).toBe('Real message');
  });
});

// ─── Raw body preservation ───────────────────────────────

describe('rawBody preservation', () => {
  it('preserves the original request body untouched', () => {
    const body = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      custom_field: 'preserved',
    };

    const result = parseRequest(body);
    expect(result.rawBody).toBe(body); // same reference
    expect((result.rawBody as any).custom_field).toBe('preserved');
  });
});
