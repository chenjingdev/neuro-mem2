/**
 * Tests for Anchor Judgment — LLM-based anchor binding decisions.
 *
 * Tests cover:
 *   1. Prompt building (anchor-judgment-prompt)
 *   2. Response parsing with validation
 *   3. Anti-hallucination (invalid anchor IDs rejected)
 *   4. AnchorJudgment service with MockLLMProvider
 *   5. Heuristic fallback when LLM fails
 *   6. Edge cases (empty candidates, isolated facts, malformed JSON)
 *   7. Pipeline traceability (stats tracking)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import {
  buildAnchorJudgmentRequest,
  getAnchorJudgmentSystemPrompt,
  type AnchorJudgmentInput,
} from '../src/extraction/anchor-judgment-prompt.js';
import {
  AnchorJudgment,
  parseAnchorJudgmentResponse,
} from '../src/services/anchor-judgment.js';
import type { AnchorCandidate } from '../src/services/anchor-candidate-finder.js';

// ─── Test Helpers ────────────────────────────────────────────────

function makeCandidates(count: number): AnchorCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    anchorId: `anchor-${i}`,
    label: `Anchor ${i}`,
    description: `Description for anchor ${i}`,
    anchorType: 'topic' as const,
    similarity: 0.8 - i * 0.1,
    effectiveWeight: 0.9,
    score: (0.8 - i * 0.1) * 0.9,
  }));
}

function makeInput(overrides?: Partial<AnchorJudgmentInput>): AnchorJudgmentInput {
  return {
    factContent: 'User prefers TypeScript for backend services',
    factCategory: 'preference',
    factEntities: ['TypeScript'],
    candidates: makeCandidates(3),
    ...overrides,
  };
}

// ─── Prompt Building ─────────────────────────────────────────────

describe('buildAnchorJudgmentRequest', () => {
  it('builds a valid LLM completion request', () => {
    const input = makeInput();
    const request = buildAnchorJudgmentRequest(input);

    expect(request.system).toContain('memory binding judge');
    expect(request.responseFormat).toBe('json');
    expect(request.temperature).toBe(0.2);
    expect(request.maxTokens).toBe(1024);
  });

  it('includes fact content in the prompt', () => {
    const input = makeInput();
    const request = buildAnchorJudgmentRequest(input);

    expect(request.prompt).toContain('User prefers TypeScript for backend services');
    expect(request.prompt).toContain('<fact>');
    expect(request.prompt).toContain('</fact>');
  });

  it('includes fact metadata', () => {
    const input = makeInput({
      factCategory: 'technical',
      factEntities: ['TypeScript', 'Node.js'],
      factFrontmatter: '{"label":"TS preference"}',
    });
    const request = buildAnchorJudgmentRequest(input);

    expect(request.prompt).toContain('Category: technical');
    expect(request.prompt).toContain('Entities: TypeScript, Node.js');
    expect(request.prompt).toContain('Frontmatter: {"label":"TS preference"}');
  });

  it('includes candidate anchors', () => {
    const input = makeInput();
    const request = buildAnchorJudgmentRequest(input);

    expect(request.prompt).toContain('<candidate_anchors>');
    expect(request.prompt).toContain('anchor-0');
    expect(request.prompt).toContain('Anchor 0');
    expect(request.prompt).toContain('anchor-1');
    expect(request.prompt).toContain('</candidate_anchors>');
  });

  it('shows "no existing anchors" when candidates are empty', () => {
    const input = makeInput({ candidates: [] });
    const request = buildAnchorJudgmentRequest(input);

    expect(request.prompt).toContain('No existing anchors found');
  });

  it('exposes system prompt for testing', () => {
    const prompt = getAnchorJudgmentSystemPrompt();
    expect(prompt).toContain('brain-like memory system');
    expect(prompt).toContain('connect');
    expect(prompt).toContain('create');
    expect(prompt).toContain('JSON');
  });
});

// ─── Response Parsing ────────────────────────────────────────────

describe('parseAnchorJudgmentResponse', () => {
  const candidates = makeCandidates(3);

  it('parses a valid connect decision', () => {
    const raw = JSON.stringify({
      decisions: [
        {
          action: 'connect',
          anchorId: 'anchor-0',
          strength: 0.8,
          reason: 'TypeScript is the main topic',
        },
      ],
      isolated: false,
    });

    const result = parseAnchorJudgmentResponse(raw, candidates);

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].action).toBe('connect');
    expect(result.decisions[0]).toMatchObject({
      action: 'connect',
      anchorId: 'anchor-0',
      strength: 0.8,
      reason: 'TypeScript is the main topic',
    });
    expect(result.isolated).toBe(false);
  });

  it('parses a valid create decision', () => {
    const raw = JSON.stringify({
      decisions: [
        {
          action: 'create',
          label: 'Backend Preferences',
          description: 'User preferences for backend technology choices',
          anchorType: 'topic',
          strength: 0.7,
          reason: 'New theme not covered',
        },
      ],
      isolated: false,
    });

    const result = parseAnchorJudgmentResponse(raw, candidates);

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      action: 'create',
      label: 'Backend Preferences',
      description: 'User preferences for backend technology choices',
      anchorType: 'topic',
      strength: 0.7,
    });
  });

  it('parses mixed connect + create decisions', () => {
    const raw = JSON.stringify({
      decisions: [
        { action: 'connect', anchorId: 'anchor-0', strength: 0.8, reason: 'relevant' },
        { action: 'create', label: 'New Topic', description: 'Desc', anchorType: 'entity', strength: 0.6, reason: 'new' },
        { action: 'connect', anchorId: 'anchor-1', strength: 0.5, reason: 'also relevant' },
      ],
      isolated: false,
    });

    const result = parseAnchorJudgmentResponse(raw, candidates);

    expect(result.decisions).toHaveLength(3);
    expect(result.decisions.filter(d => d.action === 'connect')).toHaveLength(2);
    expect(result.decisions.filter(d => d.action === 'create')).toHaveLength(1);
  });

  it('rejects connect decisions with invalid anchor IDs (anti-hallucination)', () => {
    const raw = JSON.stringify({
      decisions: [
        { action: 'connect', anchorId: 'hallucinated-id', strength: 0.9, reason: 'fake' },
        { action: 'connect', anchorId: 'anchor-0', strength: 0.7, reason: 'real' },
      ],
      isolated: false,
    });

    const result = parseAnchorJudgmentResponse(raw, candidates);

    // Only the valid anchor should remain
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      action: 'connect',
      anchorId: 'anchor-0',
    });
  });

  it('handles isolated fact', () => {
    const raw = JSON.stringify({
      decisions: [],
      isolated: true,
    });

    const result = parseAnchorJudgmentResponse(raw, candidates);
    expect(result.decisions).toHaveLength(0);
    expect(result.isolated).toBe(true);
  });

  it('clamps strength values to [0, 1]', () => {
    const raw = JSON.stringify({
      decisions: [
        { action: 'connect', anchorId: 'anchor-0', strength: 1.5, reason: 'too high' },
        { action: 'connect', anchorId: 'anchor-1', strength: -0.3, reason: 'too low' },
      ],
      isolated: false,
    });

    const result = parseAnchorJudgmentResponse(raw, candidates);

    expect(result.decisions).toHaveLength(2);
    expect((result.decisions[0] as { strength: number }).strength).toBe(1.0);
    expect((result.decisions[1] as { strength: number }).strength).toBe(0);
  });

  it('defaults invalid anchor types to "topic"', () => {
    const raw = JSON.stringify({
      decisions: [
        { action: 'create', label: 'Test', description: 'Desc', anchorType: 'invalid_type', strength: 0.5, reason: 'test' },
      ],
      isolated: false,
    });

    const result = parseAnchorJudgmentResponse(raw, candidates);
    expect(result.decisions[0]).toMatchObject({ anchorType: 'topic' });
  });

  it('skips create decisions with empty labels', () => {
    const raw = JSON.stringify({
      decisions: [
        { action: 'create', label: '', description: 'Desc', anchorType: 'topic', strength: 0.5 },
        { action: 'create', label: 'Valid', description: 'Desc', anchorType: 'topic', strength: 0.5 },
      ],
      isolated: false,
    });

    const result = parseAnchorJudgmentResponse(raw, candidates);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({ label: 'Valid' });
  });

  it('handles markdown-wrapped JSON', () => {
    const raw = '```json\n{"decisions": [{"action": "connect", "anchorId": "anchor-0", "strength": 0.8, "reason": "test"}], "isolated": false}\n```';

    const result = parseAnchorJudgmentResponse(raw, candidates);
    expect(result.decisions).toHaveLength(1);
  });

  it('throws on completely invalid JSON', () => {
    expect(() =>
      parseAnchorJudgmentResponse('not json at all', candidates),
    ).toThrow('Failed to parse');
  });

  it('defaults missing strength to 0.5', () => {
    const raw = JSON.stringify({
      decisions: [
        { action: 'connect', anchorId: 'anchor-0', reason: 'no strength' },
      ],
      isolated: false,
    });

    const result = parseAnchorJudgmentResponse(raw, candidates);
    expect((result.decisions[0] as { strength: number }).strength).toBe(0.5);
  });
});

// ─── AnchorJudgment Service ──────────────────────────────────────

describe('AnchorJudgment', () => {
  let llmProvider: MockLLMProvider;
  let judgment: AnchorJudgment;

  beforeEach(() => {
    llmProvider = new MockLLMProvider();
    judgment = new AnchorJudgment(llmProvider);
  });

  it('calls LLM and returns structured decisions', async () => {
    llmProvider.addResponse(JSON.stringify({
      decisions: [
        { action: 'connect', anchorId: 'anchor-0', strength: 0.8, reason: 'Related topic' },
        { action: 'create', label: 'New Theme', description: 'A new theme', anchorType: 'topic', strength: 0.7, reason: 'Novel concept' },
      ],
      isolated: false,
    }));

    const input = makeInput();
    const result = await judgment.judge(input);

    expect(result.source).toBe('llm');
    expect(result.decisions).toHaveLength(2);
    expect(result.stats.connectCount).toBe(1);
    expect(result.stats.createCount).toBe(1);
    expect(result.stats.candidatesPresented).toBe(3);
    expect(result.stats.llmTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.isolated).toBe(false);
    expect(result.rawResponse).toBeDefined();
  });

  it('sends correct prompt to LLM', async () => {
    llmProvider.addResponse(JSON.stringify({ decisions: [], isolated: true }));

    await judgment.judge(makeInput());

    expect(llmProvider.calls).toHaveLength(1);
    const call = llmProvider.calls[0];
    expect(call.system).toContain('memory binding judge');
    expect(call.prompt).toContain('User prefers TypeScript');
    expect(call.responseFormat).toBe('json');
  });

  it('falls back to heuristic when LLM throws', async () => {
    // No response queued → will throw
    const failingProvider: MockLLMProvider = {
      name: 'failing-mock',
      calls: [],
      async complete() {
        throw new Error('API unavailable');
      },
      addResponse() {},
      reset() {},
    } as unknown as MockLLMProvider;

    const failJudgment = new AnchorJudgment(failingProvider);

    const input = makeInput();
    // Set high similarity on first candidate so heuristic connects
    input.candidates[0].similarity = 0.8;

    const result = await failJudgment.judge(input);

    expect(result.source).toBe('heuristic');
    expect(result.error).toContain('LLM failed');
    expect(result.error).toContain('API unavailable');
    expect(result.decisions.length).toBeGreaterThanOrEqual(1);
  });

  it('heuristic connects to candidates above threshold', async () => {
    const failingProvider = {
      name: 'failing',
      async complete() { throw new Error('fail'); },
    } as unknown as MockLLMProvider;

    const heuristicJudgment = new AnchorJudgment(failingProvider, {
      heuristicConnectThreshold: 0.5,
    });

    const input = makeInput();
    input.candidates = [
      { ...makeCandidates(1)[0], similarity: 0.7 },  // Above threshold
      { ...makeCandidates(1)[0], anchorId: 'anchor-below', similarity: 0.3 },  // Below threshold
    ];

    const result = await heuristicJudgment.judge(input);

    expect(result.source).toBe('heuristic');
    const connectDecisions = result.decisions.filter(d => d.action === 'connect');
    expect(connectDecisions).toHaveLength(1);
    expect(connectDecisions[0]).toMatchObject({ anchorId: 'anchor-0' });
  });

  it('heuristic creates anchor when no candidates match and config allows', async () => {
    const failingProvider = {
      name: 'failing',
      async complete() { throw new Error('fail'); },
    } as unknown as MockLLMProvider;

    const heuristicJudgment = new AnchorJudgment(failingProvider, {
      heuristicConnectThreshold: 0.99, // Nothing will match
      heuristicCreateWhenEmpty: true,
    });

    const input = makeInput({ candidates: [] });
    const result = await heuristicJudgment.judge(input);

    expect(result.source).toBe('heuristic');
    const createDecisions = result.decisions.filter(d => d.action === 'create');
    expect(createDecisions).toHaveLength(1);
    expect(createDecisions[0]).toMatchObject({ action: 'create' });
  });

  it('marks fact as isolated when no connections and creation disabled', async () => {
    const failingProvider = {
      name: 'failing',
      async complete() { throw new Error('fail'); },
    } as unknown as MockLLMProvider;

    const heuristicJudgment = new AnchorJudgment(failingProvider, {
      heuristicConnectThreshold: 0.99,
      heuristicCreateWhenEmpty: false,
    });

    const input = makeInput({ candidates: [] });
    const result = await heuristicJudgment.judge(input);

    expect(result.isolated).toBe(true);
    expect(result.decisions).toHaveLength(0);
  });

  it('tracks pipeline stats for traceability', async () => {
    llmProvider.addResponse(JSON.stringify({
      decisions: [
        { action: 'connect', anchorId: 'anchor-0', strength: 0.8, reason: 'test' },
      ],
      isolated: false,
    }));

    const result = await judgment.judge(makeInput());

    expect(result.stats).toMatchObject({
      candidatesPresented: 3,
      connectCount: 1,
      createCount: 0,
    });
    expect(typeof result.stats.llmTimeMs).toBe('number');
    expect(result.stats.llmTimeMs).toBeGreaterThanOrEqual(0);
  });
});
