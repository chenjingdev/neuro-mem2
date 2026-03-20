/**
 * Tests for MemoryContextFormatter — validates formatting of UnifiedRecallResult
 * into LLM-injectable context blocks across all formats (XML, Markdown, plain).
 */

import { describe, it, expect } from 'vitest';
import {
  MemoryContextFormatter,
  type MemoryContextFormatterConfig,
} from '../src/retrieval/memory-context-formatter.js';
import type { UnifiedRecallResult } from '../src/retrieval/unified-retriever.js';
import type { ScoredMemoryItem } from '../src/retrieval/types.js';
import type { AnchorMatch } from '../src/retrieval/vector-searcher.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeItem(overrides: Partial<ScoredMemoryItem> = {}): ScoredMemoryItem {
  return {
    nodeId: 'fact-1',
    nodeType: 'fact',
    score: 0.85,
    source: 'vector',
    content: 'User prefers TypeScript over JavaScript',
    retrievalMetadata: {},
    ...overrides,
  };
}

function makeAnchor(overrides: Partial<AnchorMatch> = {}): AnchorMatch {
  return {
    anchorId: 'anchor-1',
    label: 'TypeScript',
    similarity: 0.92,
    effectiveWeight: 0.8,
    ...overrides,
  };
}

function makeRecallResult(
  items: ScoredMemoryItem[] = [makeItem()],
  anchors: AnchorMatch[] = [makeAnchor()],
): UnifiedRecallResult {
  return {
    items,
    activatedAnchors: anchors,
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
        { name: 'expansion', status: 'complete', durationMs: 3 },
        { name: 'bfs_expansion', status: 'complete', durationMs: 2 },
        { name: 'reinforce', status: 'complete', durationMs: 1 },
      ],
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('MemoryContextFormatter', () => {

  // ── XML Format ──

  describe('XML format', () => {
    it('produces valid XML structure with items and anchors', () => {
      const formatter = new MemoryContextFormatter({ format: 'xml' });
      const result = formatter.format(makeRecallResult());

      expect(result.text).toContain('<memory_context>');
      expect(result.text).toContain('</memory_context>');
      expect(result.text).toContain('<preamble>');
      expect(result.text).toContain('<activated_anchors>');
      expect(result.text).toContain('label="TypeScript"');
      expect(result.text).toContain('<other>');
      expect(result.text).toContain('TypeScript over JavaScript');
      expect(result.itemCount).toBe(1);
      expect(result.anchorCount).toBe(1);
      expect(result.format).toBe('xml');
    });

    it('includes scores when includeScores is true', () => {
      const formatter = new MemoryContextFormatter({
        format: 'xml',
        includeScores: true,
      });
      const result = formatter.format(makeRecallResult());

      expect(result.text).toContain('score="0.850"');
      expect(result.text).toContain('similarity="0.920"');
    });

    it('includes source info when includeSources is true', () => {
      const formatter = new MemoryContextFormatter({
        format: 'xml',
        includeSources: true,
      });
      const result = formatter.format(makeRecallResult());

      expect(result.text).toContain('source="vector"');
    });

    it('shows BFS source for BFS-expanded items', () => {
      const item = makeItem({
        retrievalMetadata: { bfsExpanded: true },
      });
      const formatter = new MemoryContextFormatter({
        format: 'xml',
        includeSources: true,
      });
      const result = formatter.format(makeRecallResult([item]));

      expect(result.text).toContain('source="bfs"');
    });

    it('includes anchor provenance in items', () => {
      const item = makeItem({
        retrievalMetadata: {
          sourceAnchorId: 'anchor-1',
        },
      });
      const anchor = makeAnchor();
      const formatter = new MemoryContextFormatter({
        format: 'xml',
        includeAnchors: true,
      });
      const result = formatter.format(makeRecallResult([item], [anchor]));

      expect(result.text).toContain('<via_anchors>TypeScript</via_anchors>');
    });

    it('hides anchors when includeAnchors is false', () => {
      const formatter = new MemoryContextFormatter({
        format: 'xml',
        includeAnchors: false,
      });
      const result = formatter.format(makeRecallResult());

      expect(result.text).not.toContain('<activated_anchors>');
      expect(result.anchorCount).toBe(0);
    });

    it('escapes XML special characters in content', () => {
      const item = makeItem({
        content: 'Use <script> & "quotes"',
      });
      const formatter = new MemoryContextFormatter({ format: 'xml' });
      const result = formatter.format(makeRecallResult([item]));

      expect(result.text).toContain('&lt;script&gt;');
      expect(result.text).toContain('&amp;');
      expect(result.text).toContain('&quot;quotes&quot;');
    });

    it('includes diagnostics when includeDiagnostics is true', () => {
      const formatter = new MemoryContextFormatter({
        format: 'xml',
        includeDiagnostics: true,
      });
      const result = formatter.format(makeRecallResult());

      expect(result.text).toContain('<diagnostics>');
      expect(result.text).toContain('<total_time_ms>21</total_time_ms>');
      expect(result.text).toContain('<pipeline>');
      expect(result.text).toContain('name="embed_query"');
    });
  });

  // ── Markdown Format ──

  describe('Markdown format', () => {
    it('produces valid Markdown structure', () => {
      const formatter = new MemoryContextFormatter({ format: 'markdown' });
      const result = formatter.format(makeRecallResult());

      expect(result.text).toContain('## Memory Context');
      expect(result.text).toContain('### Other');
      expect(result.text).toContain('- User prefers TypeScript over JavaScript');
      expect(result.format).toBe('markdown');
    });

    it('includes activated anchors', () => {
      const formatter = new MemoryContextFormatter({
        format: 'markdown',
        includeAnchors: true,
      });
      const result = formatter.format(makeRecallResult());

      expect(result.text).toContain('**Activated anchors:**');
      expect(result.text).toContain('TypeScript');
    });

    it('includes scores in markdown', () => {
      const formatter = new MemoryContextFormatter({
        format: 'markdown',
        includeScores: true,
        includeAnchors: true,
      });
      const result = formatter.format(makeRecallResult());

      expect(result.text).toContain('92%');  // anchor similarity
      expect(result.text).toContain('score: 0.850');  // item score
    });

    it('includes anchor provenance with via: suffix', () => {
      const item = makeItem({
        retrievalMetadata: { sourceAnchorId: 'anchor-1' },
      });
      const formatter = new MemoryContextFormatter({
        format: 'markdown',
        includeAnchors: true,
      });
      const result = formatter.format(makeRecallResult([item], [makeAnchor()]));

      expect(result.text).toContain('via: TypeScript');
    });

    it('includes diagnostics in markdown', () => {
      const formatter = new MemoryContextFormatter({
        format: 'markdown',
        includeDiagnostics: true,
      });
      const result = formatter.format(makeRecallResult());

      expect(result.text).toContain('_Pipeline:');
      expect(result.text).toContain('21ms');
    });
  });

  // ── Plain Text Format ──

  describe('Plain text format', () => {
    it('produces numbered list with type labels', () => {
      const formatter = new MemoryContextFormatter({ format: 'plain' });
      const result = formatter.format(makeRecallResult());

      expect(result.text).toContain('[1] (Fact/L2) User prefers TypeScript over JavaScript');
      expect(result.format).toBe('plain');
    });

    it('includes anchors as comma-separated list', () => {
      const formatter = new MemoryContextFormatter({
        format: 'plain',
        includeAnchors: true,
      });
      const result = formatter.format(makeRecallResult());

      expect(result.text).toContain('Anchors: TypeScript');
    });

    it('includes scores as percentage', () => {
      const formatter = new MemoryContextFormatter({
        format: 'plain',
        includeScores: true,
      });
      const result = formatter.format(makeRecallResult());

      expect(result.text).toContain('[85%]');
    });
  });

  // ── Multi-level Content ──

  describe('Multi-level content (frontmatter/summary/full)', () => {
    const itemWithLevels = makeItem({
      content: 'The user expressed a strong preference for TypeScript in all new projects, citing type safety and IDE support.',
      retrievalMetadata: {
        frontmatter: 'TypeScript preference | technical | high',
        summary: 'User prefers TypeScript for new projects due to type safety.',
      },
    });

    it('uses frontmatter when detailLevel is frontmatter', () => {
      const formatter = new MemoryContextFormatter({
        format: 'plain',
        detailLevel: 'frontmatter',
      });
      const result = formatter.format(makeRecallResult([itemWithLevels]));

      expect(result.text).toContain('TypeScript preference | technical | high');
      expect(result.text).not.toContain('expressed a strong preference');
    });

    it('uses summary when detailLevel is summary', () => {
      const formatter = new MemoryContextFormatter({
        format: 'plain',
        detailLevel: 'summary',
      });
      const result = formatter.format(makeRecallResult([itemWithLevels]));

      expect(result.text).toContain('User prefers TypeScript for new projects due to type safety.');
      expect(result.text).not.toContain('expressed a strong preference');
    });

    it('uses full content when detailLevel is full', () => {
      const formatter = new MemoryContextFormatter({
        format: 'plain',
        detailLevel: 'full',
      });
      const result = formatter.format(makeRecallResult([itemWithLevels]));

      expect(result.text).toContain('expressed a strong preference');
    });

    it('falls back to full content when summary/frontmatter is missing', () => {
      const itemWithoutLevels = makeItem({ content: 'Full content here' });
      const formatter = new MemoryContextFormatter({
        format: 'plain',
        detailLevel: 'frontmatter',
      });
      const result = formatter.format(makeRecallResult([itemWithoutLevels]));

      expect(result.text).toContain('Full content here');
    });

    it('falls back to summary when frontmatter is missing but summary exists', () => {
      const itemWithSummary = makeItem({
        content: 'Full content',
        retrievalMetadata: { summary: 'Summary text' },
      });
      const formatter = new MemoryContextFormatter({
        format: 'plain',
        detailLevel: 'frontmatter',
      });
      const result = formatter.format(makeRecallResult([itemWithSummary]));

      expect(result.text).toContain('Summary text');
    });
  });

  // ── Adaptive Detail Level ──

  describe('Adaptive detail level', () => {
    it('uses full content when total chars under threshold', () => {
      const item = makeItem({ content: 'Short content' }); // < 2000 chars
      const formatter = new MemoryContextFormatter({
        format: 'plain',
        detailLevel: 'adaptive',
        adaptiveThreshold: 2000,
      });
      const result = formatter.format(makeRecallResult([item]));

      expect(result.effectiveDetailLevel).toBe('full');
      expect(result.text).toContain('Short content');
    });

    it('uses summary when total chars between threshold and 2x threshold', () => {
      // Create items with total content > 2000 but < 4000
      const longContent = 'x'.repeat(300);
      const items = Array.from({ length: 10 }, (_, i) =>
        makeItem({
          nodeId: `fact-${i}`,
          content: longContent,
          retrievalMetadata: { summary: 'Brief summary' },
        })
      );
      const formatter = new MemoryContextFormatter({
        format: 'plain',
        detailLevel: 'adaptive',
        adaptiveThreshold: 2000,
      });
      const result = formatter.format(makeRecallResult(items));

      expect(result.effectiveDetailLevel).toBe('summary');
    });

    it('uses frontmatter when total chars exceed 2x threshold', () => {
      const longContent = 'x'.repeat(500);
      const items = Array.from({ length: 15 }, (_, i) =>
        makeItem({
          nodeId: `fact-${i}`,
          content: longContent,
          retrievalMetadata: { frontmatter: 'Label | cat | high' },
        })
      );
      const formatter = new MemoryContextFormatter({
        format: 'plain',
        detailLevel: 'adaptive',
        adaptiveThreshold: 2000,
      });
      const result = formatter.format(makeRecallResult(items));

      expect(result.effectiveDetailLevel).toBe('frontmatter');
    });
  });

  // ── Filtering & Limits ──

  describe('Filtering and limits', () => {
    it('filters items below minScore', () => {
      const items = [
        makeItem({ nodeId: 'f1', score: 0.9 }),
        makeItem({ nodeId: 'f2', score: 0.3 }),
        makeItem({ nodeId: 'f3', score: 0.1 }),
      ];
      const formatter = new MemoryContextFormatter({ minScore: 0.5 });
      const result = formatter.format(makeRecallResult(items));

      expect(result.itemCount).toBe(1);
    });

    it('limits items to maxItems', () => {
      const items = Array.from({ length: 20 }, (_, i) =>
        makeItem({ nodeId: `fact-${i}`, content: `Fact ${i}` })
      );
      const formatter = new MemoryContextFormatter({ maxItems: 5 });
      const result = formatter.format(makeRecallResult(items));

      expect(result.itemCount).toBe(5);
    });

    it('excludes items with empty content', () => {
      const items = [
        makeItem({ nodeId: 'f1', content: 'Valid content' }),
        makeItem({ nodeId: 'f2', content: '' }),
        makeItem({ nodeId: 'f3', content: '   ' }),
      ];
      const formatter = new MemoryContextFormatter();
      const result = formatter.format(makeRecallResult(items));

      expect(result.itemCount).toBe(1);
    });

    it('returns empty result for no items', () => {
      const formatter = new MemoryContextFormatter();
      const result = formatter.format(makeRecallResult([]));

      expect(result.text).toBe('');
      expect(result.itemCount).toBe(0);
      expect(result.anchorCount).toBe(0);
      expect(result.truncated).toBe(false);
    });
  });

  // ── Truncation ──

  describe('Truncation', () => {
    it('truncates XML and closes root tag', () => {
      const items = Array.from({ length: 10 }, (_, i) =>
        makeItem({ nodeId: `f-${i}`, content: 'x'.repeat(100) })
      );
      const formatter = new MemoryContextFormatter({
        format: 'xml',
        maxChars: 300,
      });
      const result = formatter.format(makeRecallResult(items));

      expect(result.truncated).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(300);
      expect(result.text).toContain('</memory_context>');
    });

    it('truncates Markdown with indicator', () => {
      const items = Array.from({ length: 10 }, (_, i) =>
        makeItem({ nodeId: `f-${i}`, content: 'x'.repeat(100) })
      );
      const formatter = new MemoryContextFormatter({
        format: 'markdown',
        maxChars: 300,
      });
      const result = formatter.format(makeRecallResult(items));

      expect(result.truncated).toBe(true);
      expect(result.text).toContain('[Memory context truncated]');
    });
  });

  // ── Grouping by Type ──

  describe('Grouping by type', () => {
    it('groups facts, episodes, and concepts into separate sections', () => {
      const items: ScoredMemoryItem[] = [
        makeItem({ nodeId: 'f1', nodeType: 'fact', content: 'Fact item' }),
        makeItem({ nodeId: 'e1', nodeType: 'episode', content: 'Episode item' }),
        makeItem({ nodeId: 'c1', nodeType: 'concept', content: 'Concept item' }),
      ];
      const formatter = new MemoryContextFormatter({ format: 'xml' });
      const result = formatter.format(makeRecallResult(items));

      // All three app-level nodeTypes (fact/episode/concept) end up in 'other'
      // since the formatter groups by DB-level types (semantic/episodic/procedural/etc.)
      expect(result.text).toContain('<other>');
      expect(result.text).toContain('Fact item');
      expect(result.text).toContain('Episode item');
      expect(result.text).toContain('Concept item');
      expect(result.itemCount).toBe(3);
    });
  });

  // ── System Prompt Injection ──

  describe('System prompt injection', () => {
    it('prepends context to existing system prompt', () => {
      const formatter = new MemoryContextFormatter({ format: 'plain' });
      const { systemPrompt, context } = formatter.injectIntoSystemPrompt(
        'You are a helpful assistant.',
        makeRecallResult(),
        'prepend',
      );

      expect(systemPrompt).toContain('Recalled memories:');
      expect(systemPrompt).toContain('You are a helpful assistant.');
      // Context comes before existing prompt
      const memIdx = systemPrompt.indexOf('Recalled memories:');
      const assistIdx = systemPrompt.indexOf('You are a helpful assistant.');
      expect(memIdx).toBeLessThan(assistIdx);
      expect(context.itemCount).toBe(1);
    });

    it('appends context to existing system prompt', () => {
      const formatter = new MemoryContextFormatter({ format: 'plain' });
      const { systemPrompt } = formatter.injectIntoSystemPrompt(
        'You are a helpful assistant.',
        makeRecallResult(),
        'append',
      );

      const memIdx = systemPrompt.indexOf('Recalled memories:');
      const assistIdx = systemPrompt.indexOf('You are a helpful assistant.');
      expect(assistIdx).toBeLessThan(memIdx);
    });

    it('returns unmodified prompt when no items', () => {
      const formatter = new MemoryContextFormatter();
      const { systemPrompt, context } = formatter.injectIntoSystemPrompt(
        'You are a helpful assistant.',
        makeRecallResult([]),
      );

      expect(systemPrompt).toBe('You are a helpful assistant.');
      expect(context.itemCount).toBe(0);
    });
  });

  // ── Messages Array Injection ──

  describe('Messages array injection', () => {
    it('modifies existing system message', () => {
      const formatter = new MemoryContextFormatter({ format: 'plain' });
      const messages = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ];
      const { messages: result, context } = formatter.injectIntoMessages(
        messages,
        makeRecallResult(),
      );

      expect(result[0].role).toBe('system');
      expect(result[0].content).toContain('Recalled memories:');
      expect(result[0].content).toContain('You are helpful.');
      expect(context.itemCount).toBe(1);
    });

    it('creates system message if none exists', () => {
      const formatter = new MemoryContextFormatter({ format: 'plain' });
      const messages = [{ role: 'user', content: 'Hello' }];
      const { messages: result } = formatter.injectIntoMessages(
        messages,
        makeRecallResult(),
      );

      expect(result[0].role).toBe('system');
      expect(result[0].content).toContain('Recalled memories:');
      expect(result.length).toBe(2);
    });

    it('does not mutate original messages array', () => {
      const formatter = new MemoryContextFormatter({ format: 'plain' });
      const messages = [
        { role: 'system', content: 'Original' },
        { role: 'user', content: 'Hello' },
      ];
      formatter.injectIntoMessages(messages, makeRecallResult());

      expect(messages[0].content).toBe('Original');
    });
  });

  // ── Anthropic Request Injection ──

  describe('Anthropic request injection', () => {
    it('injects into existing system field', () => {
      const formatter = new MemoryContextFormatter({ format: 'plain' });
      const request = {
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const { request: result, context } = formatter.injectIntoAnthropicRequest(
        request,
        makeRecallResult(),
      );

      expect(result.system).toContain('Recalled memories:');
      expect(result.system).toContain('You are a helpful assistant.');
      expect(context.itemCount).toBe(1);
    });

    it('creates system field if absent', () => {
      const formatter = new MemoryContextFormatter({ format: 'plain' });
      const request = {
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const { request: result } = formatter.injectIntoAnthropicRequest(
        request,
        makeRecallResult(),
      );

      expect(result.system).toContain('Recalled memories:');
    });

    it('does not mutate original request', () => {
      const formatter = new MemoryContextFormatter({ format: 'plain' });
      const request = {
        system: 'Original',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      formatter.injectIntoAnthropicRequest(request, makeRecallResult());

      expect(request.system).toBe('Original');
    });
  });

  // ── Custom Preamble ──

  describe('Custom preamble', () => {
    it('uses custom preamble text', () => {
      const formatter = new MemoryContextFormatter({
        format: 'xml',
        preamble: 'Custom memory context header',
      });
      const result = formatter.format(makeRecallResult());

      expect(result.text).toContain('Custom memory context header');
      expect(result.text).not.toContain('associative anchor activation');
    });
  });

  // ── Config Override ──

  describe('Config override per call', () => {
    it('allows overriding config per format() call', () => {
      const formatter = new MemoryContextFormatter({ format: 'xml' });
      const result = formatter.format(makeRecallResult(), { format: 'plain' });

      expect(result.format).toBe('plain');
      expect(result.text).not.toContain('<memory_context>');
    });
  });

  // ── Multiple Anchors ──

  describe('Multiple anchors', () => {
    it('shows all activated anchors', () => {
      const anchors = [
        makeAnchor({ anchorId: 'a1', label: 'TypeScript' }),
        makeAnchor({ anchorId: 'a2', label: 'React' }),
        makeAnchor({ anchorId: 'a3', label: 'Testing' }),
      ];
      const formatter = new MemoryContextFormatter({
        format: 'markdown',
        includeAnchors: true,
      });
      const result = formatter.format(makeRecallResult([makeItem()], anchors));

      expect(result.text).toContain('TypeScript');
      expect(result.text).toContain('React');
      expect(result.text).toContain('Testing');
      expect(result.anchorCount).toBe(3);
    });
  });

  // ── formatItems (partial pipeline) ──

  describe('formatItems (without full recall result)', () => {
    it('works with raw scored items and optional anchors', () => {
      const formatter = new MemoryContextFormatter({ format: 'plain' });
      const result = formatter.formatItems(
        [makeItem()],
        [makeAnchor()],
      );

      expect(result.itemCount).toBe(1);
      expect(result.text).toContain('TypeScript over JavaScript');
    });

    it('works without anchors', () => {
      const formatter = new MemoryContextFormatter({ format: 'plain' });
      const result = formatter.formatItems([makeItem()]);

      expect(result.itemCount).toBe(1);
      expect(result.anchorCount).toBe(0);
    });
  });

  // ── Brain-like behavior: anchor-based provenance ──

  describe('Brain-like behavior: anchor association context', () => {
    it('shows associative recall path (anchor → fact)', () => {
      const item = makeItem({
        content: 'Uses Vitest for testing',
        retrievalMetadata: {
          sourceAnchorId: 'anchor-test',
        },
      });
      const anchor = makeAnchor({
        anchorId: 'anchor-test',
        label: 'Testing Frameworks',
      });
      const formatter = new MemoryContextFormatter({
        format: 'xml',
        includeAnchors: true,
      });
      const result = formatter.format(makeRecallResult([item], [anchor]));

      // The output should show that "Testing Frameworks" anchor led to this fact
      expect(result.text).toContain('Testing Frameworks');
      expect(result.text).toContain('<via_anchors>Testing Frameworks</via_anchors>');
      expect(result.text).toContain('Vitest for testing');
    });

    it('shows multiple association paths for a single fact', () => {
      const item = makeItem({
        content: 'TypeScript testing with Vitest',
        retrievalMetadata: {
          sourceAnchors: [
            { anchorId: 'a1', label: 'TypeScript' },
            { anchorId: 'a2', label: 'Testing' },
          ],
        },
      });
      const anchors = [
        makeAnchor({ anchorId: 'a1', label: 'TypeScript' }),
        makeAnchor({ anchorId: 'a2', label: 'Testing' }),
      ];
      const formatter = new MemoryContextFormatter({
        format: 'xml',
        includeAnchors: true,
      });
      const result = formatter.format(makeRecallResult([item], anchors));

      expect(result.text).toContain('TypeScript, Testing');
    });

    it('distinguishes BFS-expanded items from direct matches', () => {
      const directItem = makeItem({
        nodeId: 'f1',
        content: 'Direct match',
        retrievalMetadata: {},
      });
      const bfsItem = makeItem({
        nodeId: 'f2',
        content: 'BFS expansion',
        retrievalMetadata: { bfsExpanded: true },
      });
      const formatter = new MemoryContextFormatter({
        format: 'xml',
        includeSources: true,
      });
      const result = formatter.format(makeRecallResult([directItem, bfsItem]));

      expect(result.text).toContain('source="vector"');
      expect(result.text).toContain('source="bfs"');
    });
  });

  // ── Category in attributes ──

  describe('Category metadata', () => {
    it('includes category in XML attributes', () => {
      const item = makeItem({
        retrievalMetadata: { category: 'preference' },
      });
      const formatter = new MemoryContextFormatter({ format: 'xml' });
      const result = formatter.format(makeRecallResult([item]));

      expect(result.text).toContain('category="preference"');
    });
  });
});
