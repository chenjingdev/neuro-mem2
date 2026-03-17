/**
 * Tests for context-formatter and context-injector:
 * - ContextFormatter: transforms RecallResult/MergedMemoryItem[] into structured text
 * - ContextInjector: injects formatted context into OpenAI, Anthropic, and generic requests
 */

import { describe, it, expect } from 'vitest';
import {
  ContextFormatter,
  type FormattedContext,
} from '../src/api/middleware/context-formatter.js';
import {
  ContextInjector,
  type OpenAIChatRequest,
  type AnthropicMessagesRequest,
  type InjectionResult,
} from '../src/api/middleware/context-injector.js';
import type { MergedMemoryItem } from '../src/retrieval/types.js';
import type { RecallResult } from '../src/retrieval/dual-path-retriever.js';

// ─── Test Helpers ────────────────────────────────────────

function makeFact(content: string, score = 0.8): MergedMemoryItem {
  return {
    nodeId: `fact-${Math.random().toString(36).slice(2, 8)}`,
    nodeType: 'fact',
    score,
    content,
    sources: ['vector', 'graph'],
    sourceScores: { vector: score, graph: score * 0.9 },
  };
}

function makeEpisode(content: string, score = 0.7): MergedMemoryItem {
  return {
    nodeId: `ep-${Math.random().toString(36).slice(2, 8)}`,
    nodeType: 'episode',
    score,
    content,
    sources: ['graph'],
    sourceScores: { graph: score },
  };
}

function makeConcept(content: string, score = 0.6): MergedMemoryItem {
  return {
    nodeId: `concept-${Math.random().toString(36).slice(2, 8)}`,
    nodeType: 'concept',
    score,
    content,
    sources: ['vector'],
    sourceScores: { vector: score },
  };
}

function makeRecallResult(items: MergedMemoryItem[]): RecallResult {
  return {
    items,
    diagnostics: {
      activatedAnchors: [],
      extractedEntities: [],
      graphSeedCount: 0,
      vectorTimeMs: 10,
      graphTimeMs: 15,
      totalTimeMs: 25,
      vectorItemCount: items.length,
      graphItemCount: 0,
      mergeStats: {
        vectorInputCount: items.length,
        graphInputCount: 0,
        overlapCount: 0,
        uniqueCount: items.length,
        filteredCount: items.length,
        outputCount: items.length,
        mergeTimeMs: 1,
      },
      edgesReinforced: 0,
      vectorTimedOut: false,
      graphTimedOut: false,
    },
  };
}

// ─── ContextFormatter Tests ──────────────────────────────

describe('ContextFormatter', () => {
  const formatter = new ContextFormatter();

  it('formats items in XML format by default', () => {
    const items = [
      makeFact('User prefers TypeScript'),
      makeEpisode('Debugging session on auth module'),
    ];

    const result = formatter.formatItems(items);

    expect(result.format).toBe('xml');
    expect(result.itemCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain('<memory_context>');
    expect(result.text).toContain('</memory_context>');
    expect(result.text).toContain('<facts>');
    expect(result.text).toContain('<fact>User prefers TypeScript</fact>');
    expect(result.text).toContain('<episodes>');
    expect(result.text).toContain('<episode>Debugging session on auth module</episode>');
  });

  it('formats items in markdown format', () => {
    const items = [
      makeFact('User prefers TypeScript'),
      makeConcept('Dependency injection pattern'),
    ];

    const result = formatter.formatItems(items, { format: 'markdown' });

    expect(result.format).toBe('markdown');
    expect(result.text).toContain('## Memory Context');
    expect(result.text).toContain('### Facts');
    expect(result.text).toContain('- User prefers TypeScript');
    expect(result.text).toContain('### Concepts');
    expect(result.text).toContain('- Dependency injection pattern');
  });

  it('formats items in JSON format', () => {
    const items = [makeFact('User prefers TypeScript')];

    const result = formatter.formatItems(items, { format: 'json' });

    expect(result.format).toBe('json');
    const parsed = JSON.parse(result.text);
    expect(parsed.memoryContext.facts).toHaveLength(1);
    expect(parsed.memoryContext.facts[0].content).toBe('User prefers TypeScript');
  });

  it('includes scores when configured', () => {
    const items = [makeFact('Test fact', 0.85)];

    const result = formatter.formatItems(items, { includeScores: true });

    expect(result.text).toContain('score="0.850"');
  });

  it('includes sources when configured', () => {
    const items = [makeFact('Test fact')];

    const result = formatter.formatItems(items, { includeSources: true });

    expect(result.text).toContain('sources="vector,graph"');
  });

  it('filters items below minScore', () => {
    const items = [
      makeFact('High relevance', 0.9),
      makeFact('Low relevance', 0.1),
    ];

    const result = formatter.formatItems(items, { minScore: 0.5 });

    expect(result.itemCount).toBe(1);
    expect(result.text).toContain('High relevance');
    expect(result.text).not.toContain('Low relevance');
  });

  it('limits items to maxItems', () => {
    const items = Array.from({ length: 20 }, (_, i) => makeFact(`Fact ${i}`, 0.8));

    const result = formatter.formatItems(items, { maxItems: 3 });

    expect(result.itemCount).toBe(3);
  });

  it('returns empty text for no items', () => {
    const result = formatter.formatItems([]);

    expect(result.text).toBe('');
    expect(result.itemCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('filters out items with empty content', () => {
    const items = [makeFact(''), makeFact('Valid content')];

    const result = formatter.formatItems(items);

    expect(result.itemCount).toBe(1);
    expect(result.text).toContain('Valid content');
  });

  it('truncates output when exceeding maxChars', () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      makeFact(`This is a very long fact number ${i} with lots of detail`, 0.8),
    );

    const result = formatter.formatItems(items, { maxChars: 200, maxItems: 50 });

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(200);
    expect(result.text).toContain('</memory_context>');
  });

  it('formats RecallResult via format()', () => {
    const items = [makeFact('From recall')];
    const recallResult = makeRecallResult(items);

    const result = formatter.format(recallResult);

    expect(result.itemCount).toBe(1);
    expect(result.text).toContain('From recall');
  });

  it('escapes XML special characters', () => {
    const items = [makeFact('x < 5 && y > 3 & "quoted"')];

    const result = formatter.formatItems(items);

    expect(result.text).toContain('&lt;');
    expect(result.text).toContain('&gt;');
    expect(result.text).toContain('&amp;');
    expect(result.text).toContain('&quot;');
    expect(result.text).not.toContain('x < 5');
  });

  it('groups items by type correctly', () => {
    const items = [
      makeFact('Fact A'),
      makeEpisode('Episode B'),
      makeConcept('Concept C'),
      makeFact('Fact D'),
    ];

    const result = formatter.formatItems(items);

    // Facts should be grouped together
    const factSection = result.text.indexOf('<facts>');
    const factEnd = result.text.indexOf('</facts>');
    const factsContent = result.text.slice(factSection, factEnd);
    expect(factsContent).toContain('Fact A');
    expect(factsContent).toContain('Fact D');

    // Episodes separate
    expect(result.text).toContain('<episodes>');
    expect(result.text).toContain('<concepts>');
  });

  it('uses custom preamble when provided', () => {
    const items = [makeFact('Test')];
    const result = formatter.formatItems(items, { preamble: 'Custom preamble text' });

    expect(result.text).toContain('Custom preamble text');
  });
});

// ─── ContextInjector — OpenAI Format ─────────────────────

describe('ContextInjector — OpenAI', () => {
  const injector = new ContextInjector();

  function makeOpenAIRequest(systemContent?: string): OpenAIChatRequest {
    const messages: OpenAIChatRequest['messages'] = [];
    if (systemContent) {
      messages.push({ role: 'system', content: systemContent });
    }
    messages.push({ role: 'user', content: 'What is TypeScript?' });
    return { model: 'gpt-4', messages };
  }

  it('prepends memory context to existing system message (default strategy)', () => {
    const request = makeOpenAIRequest('You are a helpful assistant.');
    const items = [makeFact('User prefers TypeScript')];
    const recall = makeRecallResult(items);

    const result = injector.injectOpenAI(request, recall);

    expect(result.injection.injected).toBe(true);
    expect(result.injection.itemCount).toBe(1);
    expect(result.injection.strategy).toBe('system_prepend');

    const systemMsg = result.request.messages.find(m => m.role === 'system');
    expect(systemMsg).toBeDefined();
    const content = systemMsg!.content as string;
    expect(content).toContain('<memory_context>');
    expect(content).toContain('User prefers TypeScript');
    // Memory context should come BEFORE the original system prompt
    const memIdx = content.indexOf('<memory_context>');
    const origIdx = content.indexOf('You are a helpful assistant.');
    expect(memIdx).toBeLessThan(origIdx);
  });

  it('appends memory context to system message with system_append strategy', () => {
    const request = makeOpenAIRequest('You are a helpful assistant.');
    const items = [makeFact('User prefers TypeScript')];
    const recall = makeRecallResult(items);

    const result = injector.injectOpenAI(request, recall, { strategy: 'system_append' });

    const systemMsg = result.request.messages.find(m => m.role === 'system');
    const content = systemMsg!.content as string;
    const memIdx = content.indexOf('<memory_context>');
    const origIdx = content.indexOf('You are a helpful assistant.');
    expect(origIdx).toBeLessThan(memIdx);
  });

  it('creates system message when none exists', () => {
    const request: OpenAIChatRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const items = [makeFact('User name is Alice')];
    const recall = makeRecallResult(items);

    const result = injector.injectOpenAI(request, recall);

    expect(result.request.messages[0].role).toBe('system');
    expect(result.request.messages[0].content as string).toContain('<memory_context>');
    expect(result.request.messages[1].role).toBe('user');
  });

  it('inserts user context message before last user message', () => {
    const request = makeOpenAIRequest('System prompt');
    request.messages.push({ role: 'assistant', content: 'Hello!' });
    request.messages.push({ role: 'user', content: 'Follow up question' });

    const items = [makeFact('Context fact')];
    const recall = makeRecallResult(items);

    const result = injector.injectOpenAI(request, recall, { strategy: 'user_context' });

    // Should insert before the last user message
    const messages = result.request.messages;
    const lastUserIdx = messages.length - 1;
    expect(messages[lastUserIdx].role).toBe('user');
    expect(messages[lastUserIdx].content).toBe('Follow up question');
    expect(messages[lastUserIdx - 1].role).toBe('user');
    expect((messages[lastUserIdx - 1].content as string)).toContain('<memory_context>');
  });

  it('inserts dedicated system message after first system message', () => {
    const request = makeOpenAIRequest('Main system prompt');
    const items = [makeFact('Dedicated context')];
    const recall = makeRecallResult(items);

    const result = injector.injectOpenAI(request, recall, { strategy: 'dedicated_message' });

    expect(result.request.messages[0].role).toBe('system');
    expect(result.request.messages[0].content).toBe('Main system prompt');
    expect(result.request.messages[1].role).toBe('system');
    expect((result.request.messages[1].content as string)).toContain('Dedicated context');
  });

  it('does not mutate the original request', () => {
    const request = makeOpenAIRequest('Original system');
    const originalJson = JSON.stringify(request);
    const items = [makeFact('New fact')];
    const recall = makeRecallResult(items);

    injector.injectOpenAI(request, recall);

    expect(JSON.stringify(request)).toBe(originalJson);
  });

  it('skips injection when items list is empty', () => {
    const request = makeOpenAIRequest('System prompt');
    const recall = makeRecallResult([]);

    const result = injector.injectOpenAI(request, recall);

    expect(result.injection.injected).toBe(false);
    expect(result.injection.itemCount).toBe(0);
    expect(result.request).toBe(request); // Same reference, not cloned
  });

  it('preserves other request fields (model, temperature, etc.)', () => {
    const request: OpenAIChatRequest = {
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
      max_tokens: 1000,
    };
    const items = [makeFact('Some fact')];
    const recall = makeRecallResult(items);

    const result = injector.injectOpenAI(request, recall);

    expect(result.request.model).toBe('gpt-4-turbo');
    expect(result.request.temperature).toBe(0.7);
    expect(result.request.max_tokens).toBe(1000);
  });
});

// ─── ContextInjector — Anthropic Format ──────────────────

describe('ContextInjector — Anthropic', () => {
  const injector = new ContextInjector();

  function makeAnthropicRequest(systemPrompt?: string): AnthropicMessagesRequest {
    return {
      model: 'claude-sonnet-4-20250514',
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [
        { role: 'user', content: 'What is TypeScript?' },
      ],
    };
  }

  it('prepends memory context to Anthropic system field', () => {
    const request = makeAnthropicRequest('You are Claude.');
    const items = [makeFact('User prefers TypeScript')];
    const recall = makeRecallResult(items);

    const result = injector.injectAnthropic(request, recall);

    expect(result.injection.injected).toBe(true);
    expect(typeof result.request.system).toBe('string');
    const system = result.request.system as string;
    expect(system).toContain('<memory_context>');
    expect(system).toContain('User prefers TypeScript');
    const memIdx = system.indexOf('<memory_context>');
    const origIdx = system.indexOf('You are Claude.');
    expect(memIdx).toBeLessThan(origIdx);
  });

  it('appends memory context to Anthropic system field', () => {
    const request = makeAnthropicRequest('You are Claude.');
    const items = [makeFact('Appended fact')];
    const recall = makeRecallResult(items);

    const result = injector.injectAnthropic(request, recall, { strategy: 'system_append' });

    const system = result.request.system as string;
    const origIdx = system.indexOf('You are Claude.');
    const memIdx = system.indexOf('<memory_context>');
    expect(origIdx).toBeLessThan(memIdx);
  });

  it('creates system field when none exists', () => {
    const request = makeAnthropicRequest();
    const items = [makeFact('New context')];
    const recall = makeRecallResult(items);

    const result = injector.injectAnthropic(request, recall);

    expect(result.request.system).toBeDefined();
    expect((result.request.system as string)).toContain('<memory_context>');
  });

  it('injects user_context message before last user message', () => {
    const request: AnthropicMessagesRequest = {
      model: 'claude-sonnet-4-20250514',
      system: 'System prompt',
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow up' },
      ],
    };
    const items = [makeFact('User context fact')];
    const recall = makeRecallResult(items);

    const result = injector.injectAnthropic(request, recall, { strategy: 'user_context' });

    const msgs = result.request.messages;
    // Context message should be inserted before "Follow up"
    expect(msgs[msgs.length - 1].content).toBe('Follow up');
    expect((msgs[msgs.length - 2].content as string)).toContain('<memory_context>');
    expect(msgs[msgs.length - 2].role).toBe('user');
  });

  it('does not mutate the original Anthropic request', () => {
    const request = makeAnthropicRequest('Original');
    const originalJson = JSON.stringify(request);
    const items = [makeFact('Injected')];
    const recall = makeRecallResult(items);

    injector.injectAnthropic(request, recall);

    expect(JSON.stringify(request)).toBe(originalJson);
  });
});

// ─── ContextInjector — System Prompt ─────────────────────

describe('ContextInjector — System Prompt', () => {
  const injector = new ContextInjector();

  it('prepends memory context to a plain system prompt', () => {
    const items = [makeFact('User likes Python')];
    const recall = makeRecallResult(items);

    const { systemPrompt } = injector.injectIntoSystemPrompt(
      'You are a coding assistant.',
      recall,
    );

    expect(systemPrompt).toContain('<memory_context>');
    const memIdx = systemPrompt.indexOf('<memory_context>');
    const origIdx = systemPrompt.indexOf('You are a coding assistant.');
    expect(memIdx).toBeLessThan(origIdx);
  });

  it('appends memory context when configured', () => {
    const items = [makeFact('User likes Python')];
    const recall = makeRecallResult(items);

    const { systemPrompt } = injector.injectIntoSystemPrompt(
      'You are a coding assistant.',
      recall,
      { strategy: 'system_append' },
    );

    const origIdx = systemPrompt.indexOf('You are a coding assistant.');
    const memIdx = systemPrompt.indexOf('<memory_context>');
    expect(origIdx).toBeLessThan(memIdx);
  });

  it('returns original prompt when no items', () => {
    const recall = makeRecallResult([]);

    const { systemPrompt, formattedContext } = injector.injectIntoSystemPrompt(
      'Original prompt',
      recall,
    );

    expect(systemPrompt).toBe('Original prompt');
    expect(formattedContext.itemCount).toBe(0);
  });
});

// ─── ContextInjector — Auto-detect ───────────────────────

describe('ContextInjector — Auto-detect', () => {
  const injector = new ContextInjector();

  it('auto-detects Anthropic format (top-level system + no system role messages)', () => {
    const request: Record<string, unknown> = {
      model: 'claude-sonnet-4-20250514',
      system: 'You are Claude.',
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    };
    const items = [makeFact('Auto-detected fact')];
    const recall = makeRecallResult(items);

    const result = injector.injectAuto(request, recall);

    expect(result.injection.injected).toBe(true);
    expect((result.request.system as string)).toContain('<memory_context>');
  });

  it('auto-detects OpenAI format (system role in messages)', () => {
    const request: Record<string, unknown> = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
    };
    const items = [makeFact('OpenAI fact')];
    const recall = makeRecallResult(items);

    const result = injector.injectAuto(request, recall);

    expect(result.injection.injected).toBe(true);
    const msgs = (result.request as OpenAIChatRequest).messages;
    const systemMsg = msgs.find(m => m.role === 'system');
    expect((systemMsg!.content as string)).toContain('<memory_context>');
  });

  it('falls back to adding system field for unknown formats', () => {
    const request: Record<string, unknown> = {
      model: 'custom-model',
      prompt: 'Some prompt',
    };
    const items = [makeFact('Fallback fact')];
    const recall = makeRecallResult(items);

    const result = injector.injectAuto(request, recall);

    expect(result.injection.injected).toBe(true);
    expect(typeof result.request.system).toBe('string');
    expect((result.request.system as string)).toContain('<memory_context>');
  });
});

// ─── Integration: Format + Inject ────────────────────────

describe('Integration: Format + Inject', () => {
  it('end-to-end: recall → format → inject into OpenAI request', () => {
    const items: MergedMemoryItem[] = [
      makeFact('User is building a TypeScript project', 0.95),
      makeFact('User prefers Vitest for testing', 0.85),
      makeEpisode('Debugged a SQLite connection issue yesterday', 0.75),
      makeConcept('Dependency injection pattern in Node.js', 0.6),
    ];
    const recall = makeRecallResult(items);

    const injector = new ContextInjector({
      formatter: { format: 'xml', includeScores: false },
    });

    const request: OpenAIChatRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are an expert TypeScript developer.' },
        { role: 'user', content: 'How should I structure my test files?' },
      ],
    };

    const result = injector.injectOpenAI(request, recall);

    expect(result.injection.injected).toBe(true);
    expect(result.injection.itemCount).toBe(4);

    const systemContent = result.request.messages[0].content as string;
    expect(systemContent).toContain('TypeScript project');
    expect(systemContent).toContain('Vitest for testing');
    expect(systemContent).toContain('SQLite connection');
    expect(systemContent).toContain('Dependency injection');
    expect(systemContent).toContain('expert TypeScript developer');
  });

  it('end-to-end: recall → format → inject into Anthropic request', () => {
    const items = [
      makeFact('User uses Bun runtime', 0.9),
      makeEpisode('Set up a proxy server last week', 0.7),
    ];
    const recall = makeRecallResult(items);

    const injector = new ContextInjector({
      strategy: 'system_append',
      formatter: { format: 'markdown' },
    });

    const request: AnthropicMessagesRequest = {
      model: 'claude-sonnet-4-20250514',
      system: 'You are a helpful coding assistant.',
      messages: [
        { role: 'user', content: 'How do I configure a proxy?' },
      ],
    };

    const result = injector.injectAnthropic(request, recall);

    const system = result.request.system as string;
    expect(system).toContain('You are a helpful coding assistant.');
    expect(system).toContain('## Memory Context');
    expect(system).toContain('Bun runtime');
    expect(system).toContain('proxy server last week');
  });
});
