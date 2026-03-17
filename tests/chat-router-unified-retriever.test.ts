/**
 * Tests for chat-router integration with UnifiedRetriever.
 *
 * Validates that the chat router correctly calls UnifiedRetriever.recall()
 * when a unifiedRetriever dependency is provided, maps results to memory
 * context for LLM injection, and emits proper trace events.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createChatRouter,
  type ChatRouterDependencies,
  type TraceEvent,
  type DoneEvent,
} from '../src/chat/chat-router.js';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamRequest,
  LLMStreamEvent,
} from '../src/extraction/llm-provider.js';
import type {
  UnifiedRetriever,
  UnifiedRecallQuery,
  UnifiedRecallResult,
} from '../src/retrieval/unified-retriever.js';

// ─── Mock LLM Provider ────────────────────────────────────

class MockLLM implements LLMProvider {
  readonly name = 'mock-llm';
  public streamCalls: LLMStreamRequest[] = [];

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    return { content: 'response' };
  }

  async *stream(req: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    this.streamCalls.push(req);
    yield { type: 'delta', content: 'Hi' };
    yield { type: 'finish', content: 'Hi there', usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } };
  }
}

// ─── Mock UnifiedRetriever ────────────────────────────────

function createMockUnifiedRetriever(result: UnifiedRecallResult): UnifiedRetriever {
  return {
    recall: vi.fn().mockResolvedValue(result),
    config: {} as any,
  } as unknown as UnifiedRetriever;
}

// ─── SSE Parsing Helpers ──────────────────────────────────

async function collectSSEEvents(response: Response): Promise<{
  traces: TraceEvent[];
  chats: Array<{ type: string; content?: string }>;
  done: DoneEvent | null;
}> {
  const text = await response.text();
  const traces: TraceEvent[] = [];
  const chats: Array<{ type: string; content?: string }> = [];
  let done: DoneEvent | null = null;

  const lines = text.split('\n');
  let currentEvent = '';
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);
      if (currentEvent && currentData) {
        try {
          const parsed = JSON.parse(currentData);
          if (currentEvent === 'trace') traces.push(parsed);
          else if (currentEvent === 'chat') chats.push(parsed);
          else if (currentEvent === 'done') done = parsed;
        } catch { /* skip non-JSON */ }
      }
      currentEvent = '';
      currentData = '';
    }
  }

  return { traces, chats, done };
}

// ─── Tests ────────────────────────────────────────────────

describe('chat-router + UnifiedRetriever integration', () => {
  it('calls UnifiedRetriever.recall() with the user message', async () => {
    const mockResult: UnifiedRecallResult = {
      items: [
        { nodeId: 'f1', nodeType: 'fact', score: 0.85, source: 'vector', content: 'User likes TypeScript' },
      ],
      activatedAnchors: [
        { anchorId: 'a1', label: 'programming', similarity: 0.9 },
      ],
      diagnostics: {
        embeddingTimeMs: 10,
        anchorSearchTimeMs: 5,
        expansionTimeMs: 3,
        rerankTimeMs: 0,
        llmRerankTimeMs: 0,
        bfsExpansionTimeMs: 2,
        reinforceTimeMs: 1,
        totalTimeMs: 21,
        anchorsCompared: 10,
        anchorsMatched: 1,
        nodesExpanded: 1,
        bfsNodesAdded: 0,
        edgesReinforced: 1,
        stages: [
          { name: 'embed_query', status: 'complete', durationMs: 10 },
          { name: 'anchor_search', status: 'complete', durationMs: 5 },
        ],
      },
    };

    const retriever = createMockUnifiedRetriever(mockResult);
    const llm = new MockLLM();

    const deps: ChatRouterDependencies = {
      llmProvider: llm,
      unifiedRetriever: retriever,
    };

    const router = createChatRouter(deps);
    const req = new Request('http://localhost/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Tell me about TypeScript' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    // Verify recall was called with the user's message
    expect(retriever.recall).toHaveBeenCalledWith({ text: 'Tell me about TypeScript' });

    const { traces, chats, done } = await collectSSEEvents(res);

    // Should have recall start + sub-stage traces + recall complete
    const recallStart = traces.find(t => t.stage === 'recall' && t.status === 'start');
    expect(recallStart).toBeDefined();
    expect(recallStart!.data).toMatchObject({ mode: 'unified' });

    const recallComplete = traces.find(t => t.stage === 'recall' && t.status === 'complete');
    expect(recallComplete).toBeDefined();
    expect(recallComplete!.data).toMatchObject({
      mode: 'unified',
      itemCount: 1,
    });

    // Sub-stage traces from diagnostics.stages should be emitted
    const embedStage = traces.find(t => t.stage === 'embed_query');
    expect(embedStage).toBeDefined();
    const anchorStage = traces.find(t => t.stage === 'anchor_search');
    expect(anchorStage).toBeDefined();
  });

  it('injects retrieved memory into LLM system prompt', async () => {
    const mockResult: UnifiedRecallResult = {
      items: [
        { nodeId: 'f1', nodeType: 'fact', score: 0.92, source: 'vector', content: 'User works at ACME Corp' },
        { nodeId: 'f2', nodeType: 'fact', score: 0.78, source: 'bfs_expansion', content: 'User prefers dark mode' },
      ],
      activatedAnchors: [{ anchorId: 'a1', label: 'user-prefs', similarity: 0.88 }],
      diagnostics: {
        embeddingTimeMs: 8, anchorSearchTimeMs: 4, expansionTimeMs: 2,
        rerankTimeMs: 0, llmRerankTimeMs: 0, bfsExpansionTimeMs: 1,
        reinforceTimeMs: 0, totalTimeMs: 15,
        anchorsCompared: 5, anchorsMatched: 1, nodesExpanded: 2,
        bfsNodesAdded: 1, edgesReinforced: 0, stages: [],
      },
    };

    const retriever = createMockUnifiedRetriever(mockResult);
    const llm = new MockLLM();

    const router = createChatRouter({
      llmProvider: llm,
      unifiedRetriever: retriever,
    });

    const req = new Request('http://localhost/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What company do I work at?' }),
    });

    await router.fetch(req);

    // The LLM should have been called with memory context in the system prompt
    expect(llm.streamCalls.length).toBe(1);
    const systemPrompt = llm.streamCalls[0].system!;
    expect(systemPrompt).toContain('Retrieved Memory Context');
    expect(systemPrompt).toContain('User works at ACME Corp');
    expect(systemPrompt).toContain('User prefers dark mode');
    expect(systemPrompt).toContain('[Memory 1]');
    expect(systemPrompt).toContain('[Memory 2]');
  });

  it('takes precedence over DualPathRetriever when both provided', async () => {
    const unifiedResult: UnifiedRecallResult = {
      items: [{ nodeId: 'f1', nodeType: 'fact', score: 0.9, source: 'vector', content: 'from unified' }],
      activatedAnchors: [],
      diagnostics: {
        embeddingTimeMs: 5, anchorSearchTimeMs: 3, expansionTimeMs: 1,
        rerankTimeMs: 0, llmRerankTimeMs: 0, bfsExpansionTimeMs: 0,
        reinforceTimeMs: 0, totalTimeMs: 9,
        anchorsCompared: 3, anchorsMatched: 0, nodesExpanded: 1,
        bfsNodesAdded: 0, edgesReinforced: 0, stages: [],
      },
    };

    const unifiedRetriever = createMockUnifiedRetriever(unifiedResult);
    const dualPathRetriever = {
      recall: vi.fn().mockResolvedValue({ items: [], diagnostics: {} }),
    };
    const llm = new MockLLM();

    const router = createChatRouter({
      llmProvider: llm,
      unifiedRetriever: unifiedRetriever,
      retriever: dualPathRetriever as any,
    });

    const req = new Request('http://localhost/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test' }),
    });

    await router.fetch(req);

    // Unified should be called, DualPath should NOT
    expect(unifiedRetriever.recall).toHaveBeenCalledTimes(1);
    expect(dualPathRetriever.recall).not.toHaveBeenCalled();

    // LLM prompt should contain unified result
    expect(llm.streamCalls[0].system).toContain('from unified');
  });

  it('gracefully handles UnifiedRetriever errors', async () => {
    const retriever = {
      recall: vi.fn().mockRejectedValue(new Error('Embedding model failed')),
      config: {},
    } as unknown as UnifiedRetriever;

    const llm = new MockLLM();

    const router = createChatRouter({
      llmProvider: llm,
      unifiedRetriever: retriever,
    });

    const req = new Request('http://localhost/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200); // Should still return 200 (non-fatal)

    const { traces, chats } = await collectSSEEvents(res);

    // Should have recall error trace
    const recallError = traces.find(t => t.stage === 'recall' && t.status === 'error');
    expect(recallError).toBeDefined();
    expect((recallError!.data as any).error).toContain('Embedding model failed');

    // LLM should still be called (without memory context)
    expect(chats.length).toBeGreaterThan(0);
  });

  it('reports unified retriever on health endpoint', async () => {
    const llm = new MockLLM();
    const retriever = createMockUnifiedRetriever({
      items: [], activatedAnchors: [],
      diagnostics: {
        embeddingTimeMs: 0, anchorSearchTimeMs: 0, expansionTimeMs: 0,
        rerankTimeMs: 0, llmRerankTimeMs: 0, bfsExpansionTimeMs: 0,
        reinforceTimeMs: 0, totalTimeMs: 0,
        anchorsCompared: 0, anchorsMatched: 0, nodesExpanded: 0,
        bfsNodesAdded: 0, edgesReinforced: 0, stages: [],
      },
    });

    const router = createChatRouter({
      llmProvider: llm,
      unifiedRetriever: retriever,
    });

    const req = new Request('http://localhost/chat/health');
    const res = await router.fetch(req);
    const body = await res.json();

    expect(body.hasUnifiedRetriever).toBe(true);
  });

  it('emits pipeline:complete with recallMode=unified', async () => {
    const mockResult: UnifiedRecallResult = {
      items: [],
      activatedAnchors: [],
      diagnostics: {
        embeddingTimeMs: 5, anchorSearchTimeMs: 3, expansionTimeMs: 0,
        rerankTimeMs: 0, llmRerankTimeMs: 0, bfsExpansionTimeMs: 0,
        reinforceTimeMs: 0, totalTimeMs: 8,
        anchorsCompared: 0, anchorsMatched: 0, nodesExpanded: 0,
        bfsNodesAdded: 0, edgesReinforced: 0, stages: [],
      },
    };

    const retriever = createMockUnifiedRetriever(mockResult);
    const llm = new MockLLM();

    const router = createChatRouter({
      llmProvider: llm,
      unifiedRetriever: retriever,
    });

    const req = new Request('http://localhost/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test' }),
    });

    const res = await router.fetch(req);
    const { traces } = await collectSSEEvents(res);

    const pipelineComplete = traces.find(t => t.stage === 'pipeline' && t.status === 'complete');
    expect(pipelineComplete).toBeDefined();
    expect((pipelineComplete!.data as any).recallMode).toBe('unified');
  });
});
