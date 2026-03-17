/**
 * Tests for ResultMerger — dual-path retrieval result merging.
 *
 * Covers:
 *   - Deduplication of overlapping results
 *   - Min-max score normalization
 *   - Weighted score combination
 *   - Convergence bonus for items in both paths
 *   - Minimum score filtering
 *   - Ranking and limit enforcement
 *   - Edge cases (empty inputs, single path, identical scores)
 */

import { describe, it, expect } from 'vitest';
import {
  ResultMerger,
  DEFAULT_MERGER_CONFIG,
  minMaxNormalize,
  clamp01,
  roundScore,
} from '../src/retrieval/result-merger.js';
import type { ScoredMemoryItem, MergedMemoryItem, RetrievalSource } from '../src/retrieval/types.js';

// ─── Test Helpers ─────────────────────────────────────────────

function makeItem(
  nodeId: string,
  score: number,
  source: RetrievalSource,
  nodeType: 'fact' | 'episode' | 'concept' | 'anchor' = 'fact',
  content?: string,
): ScoredMemoryItem {
  return {
    nodeId,
    nodeType,
    score,
    source,
    content: content ?? `Content of ${nodeId}`,
  };
}

function vectorItem(nodeId: string, score: number, content?: string): ScoredMemoryItem {
  return makeItem(nodeId, score, 'vector', 'fact', content);
}

function graphItem(nodeId: string, score: number, content?: string): ScoredMemoryItem {
  return makeItem(nodeId, score, 'graph', 'fact', content);
}

// ─── Tests ────────────────────────────────────────────────────

describe('ResultMerger', () => {
  describe('constructor', () => {
    it('uses default config when no options provided', () => {
      const merger = new ResultMerger();
      expect(merger.config).toEqual(DEFAULT_MERGER_CONFIG);
    });

    it('allows partial config overrides', () => {
      const merger = new ResultMerger({ vectorWeight: 0.7, maxResults: 10 });
      expect(merger.config.vectorWeight).toBe(0.7);
      expect(merger.config.maxResults).toBe(10);
      // Defaults preserved
      expect(merger.config.convergenceBonus).toBe(DEFAULT_MERGER_CONFIG.convergenceBonus);
    });

    it('rejects invalid vectorWeight', () => {
      expect(() => new ResultMerger({ vectorWeight: 1.5 })).toThrow('vectorWeight');
      expect(() => new ResultMerger({ vectorWeight: -0.1 })).toThrow('vectorWeight');
    });

    it('rejects invalid convergenceBonus', () => {
      expect(() => new ResultMerger({ convergenceBonus: 2.0 })).toThrow('convergenceBonus');
    });

    it('rejects invalid minScore', () => {
      expect(() => new ResultMerger({ minScore: -1 })).toThrow('minScore');
    });

    it('rejects invalid maxResults', () => {
      expect(() => new ResultMerger({ maxResults: 0 })).toThrow('maxResults');
    });
  });

  describe('merge — basic merging', () => {
    it('merges non-overlapping results from both paths', () => {
      const merger = new ResultMerger({ normalization: 'none', convergenceBonus: 0 });
      const vectorResults = [vectorItem('a', 0.9), vectorItem('b', 0.7)];
      const graphResults = [graphItem('c', 0.8), graphItem('d', 0.6)];

      const result = merger.merge(vectorResults, graphResults);

      expect(result.items).toHaveLength(4);
      expect(result.stats.vectorInputCount).toBe(2);
      expect(result.stats.graphInputCount).toBe(2);
      expect(result.stats.overlapCount).toBe(0);
      expect(result.stats.uniqueCount).toBe(4);

      // Each item should have only one source
      for (const item of result.items) {
        expect(item.sources).toHaveLength(1);
      }
    });

    it('deduplicates overlapping results and applies convergence bonus', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        vectorWeight: 0.5,
        convergenceBonus: 0.1,
      });

      const vectorResults = [vectorItem('shared', 0.8), vectorItem('v-only', 0.6)];
      const graphResults = [graphItem('shared', 0.7), graphItem('g-only', 0.9)];

      const result = merger.merge(vectorResults, graphResults);

      expect(result.stats.overlapCount).toBe(1);
      expect(result.stats.uniqueCount).toBe(3);

      const shared = result.items.find(i => i.nodeId === 'shared')!;
      expect(shared).toBeDefined();
      expect(shared.sources).toContain('vector');
      expect(shared.sources).toContain('graph');
      expect(shared.sourceScores.vector).toBe(0.8);
      expect(shared.sourceScores.graph).toBe(0.7);
      // Score = 0.5 * 0.8 + 0.5 * 0.7 + 0.1 = 0.85
      expect(shared.score).toBeCloseTo(0.85, 3);
    });

    it('returns empty result when both paths are empty', () => {
      const merger = new ResultMerger();
      const result = merger.merge([], []);

      expect(result.items).toHaveLength(0);
      expect(result.stats.vectorInputCount).toBe(0);
      expect(result.stats.graphInputCount).toBe(0);
      expect(result.stats.overlapCount).toBe(0);
      expect(result.stats.uniqueCount).toBe(0);
    });
  });

  describe('merge — single path scenarios', () => {
    it('handles vector-only results', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        vectorWeight: 0.6,
        convergenceBonus: 0,
      });

      const vectorResults = [vectorItem('a', 0.8), vectorItem('b', 0.5)];
      const result = merger.merge(vectorResults, []);

      expect(result.items).toHaveLength(2);
      // vector-only: score = vectorWeight * rawScore
      const itemA = result.items.find(i => i.nodeId === 'a')!;
      expect(itemA.score).toBeCloseTo(0.6 * 0.8, 3);
      expect(itemA.sources).toEqual(['vector']);
    });

    it('handles graph-only results', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        vectorWeight: 0.4,
        convergenceBonus: 0,
      });

      const graphResults = [graphItem('a', 0.9)];
      const result = merger.merge([], graphResults);

      expect(result.items).toHaveLength(1);
      // graph-only: score = graphWeight * rawScore = 0.6 * 0.9
      const itemA = result.items[0];
      expect(itemA.score).toBeCloseTo(0.6 * 0.9, 3);
      expect(itemA.sources).toEqual(['graph']);
    });
  });

  describe('merge — score normalization', () => {
    it('min-max normalizes scores within each path', () => {
      const merger = new ResultMerger({
        normalization: 'minmax',
        vectorWeight: 0.5,
        convergenceBonus: 0,
        minScore: 0,
      });

      // Vector scores: raw [0.2, 0.6] → normalized [0.0, 1.0]
      // Graph scores: raw [0.3, 0.9] → normalized [0.0, 1.0]
      const vectorResults = [vectorItem('a', 0.6), vectorItem('b', 0.2)];
      const graphResults = [graphItem('c', 0.9), graphItem('d', 0.3)];

      const result = merger.merge(vectorResults, graphResults);

      // 'a' (vector, normalized=1.0): score = 0.5 * 1.0 = 0.5
      const itemA = result.items.find(i => i.nodeId === 'a')!;
      expect(itemA.score).toBeCloseTo(0.5, 3);

      // 'b' (vector, normalized=0.0): score = 0.5 * 0.0 = 0.0
      const itemB = result.items.find(i => i.nodeId === 'b')!;
      expect(itemB.score).toBeCloseTo(0.0, 3);

      // 'c' (graph, normalized=1.0): score = 0.5 * 1.0 = 0.5
      const itemC = result.items.find(i => i.nodeId === 'c')!;
      expect(itemC.score).toBeCloseTo(0.5, 3);
    });

    it('handles single-item path normalization (normalizes to 1.0)', () => {
      const merger = new ResultMerger({
        normalization: 'minmax',
        vectorWeight: 0.5,
        convergenceBonus: 0,
        minScore: 0,
      });

      const vectorResults = [vectorItem('a', 0.3)];
      const result = merger.merge(vectorResults, []);

      // Single item → normalized to 1.0
      expect(result.items[0].score).toBeCloseTo(0.5, 3); // 0.5 * 1.0
    });

    it('handles identical scores in normalization (all become 1.0)', () => {
      const merger = new ResultMerger({
        normalization: 'minmax',
        vectorWeight: 0.5,
        convergenceBonus: 0,
        minScore: 0,
      });

      const vectorResults = [vectorItem('a', 0.5), vectorItem('b', 0.5)];
      const result = merger.merge(vectorResults, []);

      // All identical → all normalized to 1.0
      for (const item of result.items) {
        expect(item.score).toBeCloseTo(0.5, 3);
      }
    });
  });

  describe('merge — filtering and limiting', () => {
    it('filters out items below minScore', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        vectorWeight: 0.5,
        convergenceBonus: 0,
        minScore: 0.3,
      });

      const vectorResults = [
        vectorItem('high', 0.8),   // 0.5 * 0.8 = 0.4 → passes
        vectorItem('low', 0.2),    // 0.5 * 0.2 = 0.1 → filtered
      ];

      const result = merger.merge(vectorResults, []);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].nodeId).toBe('high');
      expect(result.stats.filteredCount).toBe(1);
    });

    it('limits results to maxResults', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        convergenceBonus: 0,
        maxResults: 3,
        minScore: 0,
      });

      const vectorResults = Array.from({ length: 10 }, (_, i) =>
        vectorItem(`item-${i}`, 0.9 - i * 0.05),
      );

      const result = merger.merge(vectorResults, []);

      expect(result.items).toHaveLength(3);
      expect(result.stats.outputCount).toBe(3);
    });
  });

  describe('merge — ranking', () => {
    it('ranks items by final score descending', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        vectorWeight: 0.5,
        convergenceBonus: 0.1,
        minScore: 0,
      });

      const vectorResults = [vectorItem('a', 0.3), vectorItem('shared', 0.8)];
      const graphResults = [graphItem('b', 0.9), graphItem('shared', 0.7)];

      const result = merger.merge(vectorResults, graphResults);

      // Verify descending order
      for (let i = 1; i < result.items.length; i++) {
        expect(result.items[i - 1].score).toBeGreaterThanOrEqual(result.items[i].score);
      }

      // 'shared' should be top: 0.5*0.8 + 0.5*0.7 + 0.1 = 0.85
      expect(result.items[0].nodeId).toBe('shared');
    });

    it('prefers dual-source items when scores tie', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        vectorWeight: 0.5,
        convergenceBonus: 0,
        minScore: 0,
      });

      // Both yield score = 0.5
      const vectorResults = [vectorItem('single', 1.0), vectorItem('dual', 0.6)];
      const graphResults = [graphItem('dual', 0.4)];

      const result = merger.merge(vectorResults, graphResults);

      const singleItem = result.items.find(i => i.nodeId === 'single')!;
      const dualItem = result.items.find(i => i.nodeId === 'dual')!;

      // Both have score 0.5, but 'dual' has 2 sources → ranked first
      expect(dualItem.score).toBe(singleItem.score);
      expect(result.items[0].nodeId).toBe('dual');
    });
  });

  describe('merge — convergence bonus', () => {
    it('adds convergence bonus only to items found in both paths', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        vectorWeight: 0.5,
        convergenceBonus: 0.15,
        minScore: 0,
      });

      const vectorResults = [vectorItem('both', 0.6), vectorItem('v-only', 0.6)];
      const graphResults = [graphItem('both', 0.6), graphItem('g-only', 0.6)];

      const result = merger.merge(vectorResults, graphResults);

      const both = result.items.find(i => i.nodeId === 'both')!;
      const vOnly = result.items.find(i => i.nodeId === 'v-only')!;
      const gOnly = result.items.find(i => i.nodeId === 'g-only')!;

      // 'both': 0.5*0.6 + 0.5*0.6 + 0.15 = 0.75
      expect(both.score).toBeCloseTo(0.75, 3);
      // 'v-only': 0.5*0.6 = 0.3
      expect(vOnly.score).toBeCloseTo(0.3, 3);
      // 'g-only': 0.5*0.6 = 0.3
      expect(gOnly.score).toBeCloseTo(0.3, 3);
    });

    it('clamps score to 1.0 even with high convergence bonus', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        vectorWeight: 0.5,
        convergenceBonus: 0.5,
        minScore: 0,
      });

      const vectorResults = [vectorItem('x', 1.0)];
      const graphResults = [graphItem('x', 1.0)];

      const result = merger.merge(vectorResults, graphResults);

      // 0.5*1.0 + 0.5*1.0 + 0.5 = 1.5 → clamped to 1.0
      expect(result.items[0].score).toBe(1.0);
    });
  });

  describe('merge — weighted configuration', () => {
    it('respects vectorWeight vs graphWeight balance', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        vectorWeight: 0.8,
        convergenceBonus: 0,
        minScore: 0,
      });

      // Both paths return same node with same score
      const vectorResults = [vectorItem('n', 1.0)];
      const graphResults = [graphItem('n', 1.0)];

      const result = merger.merge(vectorResults, graphResults);

      // 0.8*1.0 + 0.2*1.0 = 1.0 (no bias visible here)
      expect(result.items[0].score).toBeCloseTo(1.0, 3);

      // Now with different scores to see the bias
      const merger2 = new ResultMerger({
        normalization: 'none',
        vectorWeight: 0.8,
        convergenceBonus: 0,
        minScore: 0,
      });

      const r2 = merger2.merge(
        [vectorItem('n', 1.0)],
        [graphItem('n', 0.0)],
      );

      // 0.8*1.0 + 0.2*0.0 = 0.8
      expect(r2.items[0].score).toBeCloseTo(0.8, 3);
    });
  });

  describe('merge — metadata handling', () => {
    it('preserves and prefixes retrieval metadata from both sources', () => {
      const merger = new ResultMerger({ normalization: 'none', minScore: 0 });

      const vectorResults: ScoredMemoryItem[] = [{
        nodeId: 'n',
        nodeType: 'fact',
        score: 0.8,
        source: 'vector',
        content: 'test',
        retrievalMetadata: { anchorId: 'a1', distance: 0.2 },
      }];

      const graphResults: ScoredMemoryItem[] = [{
        nodeId: 'n',
        nodeType: 'fact',
        score: 0.7,
        source: 'graph',
        content: 'test',
        retrievalMetadata: { hops: 2, pathWeight: 0.65 },
      }];

      const result = merger.merge(vectorResults, graphResults);

      const item = result.items[0];
      expect(item.retrievalMetadata).toBeDefined();
      expect(item.retrievalMetadata!['vector_anchorId']).toBe('a1');
      expect(item.retrievalMetadata!['vector_distance']).toBe(0.2);
      expect(item.retrievalMetadata!['graph_hops']).toBe(2);
      expect(item.retrievalMetadata!['graph_pathWeight']).toBe(0.65);
    });

    it('omits retrievalMetadata when no metadata present', () => {
      const merger = new ResultMerger({ normalization: 'none', minScore: 0 });

      const result = merger.merge([vectorItem('a', 0.5)], []);
      expect(result.items[0].retrievalMetadata).toBeUndefined();
    });
  });

  describe('merge — content preservation', () => {
    it('preserves content from the first occurrence', () => {
      const merger = new ResultMerger({ normalization: 'none', minScore: 0 });

      const vectorResults = [vectorItem('n', 0.8, 'Vector content')];
      const graphResults = [graphItem('n', 0.7, 'Graph content')];

      const result = merger.merge(vectorResults, graphResults);

      // Vector items are processed first
      expect(result.items[0].content).toBe('Vector content');
    });
  });

  describe('merge — mixed node types', () => {
    it('handles different node types correctly', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        convergenceBonus: 0,
        minScore: 0,
      });

      const vectorResults: ScoredMemoryItem[] = [
        makeItem('f1', 0.9, 'vector', 'fact'),
        makeItem('e1', 0.7, 'vector', 'episode'),
      ];

      const graphResults: ScoredMemoryItem[] = [
        makeItem('c1', 0.8, 'graph', 'concept'),
        makeItem('f1', 0.6, 'graph', 'fact'),
      ];

      const result = merger.merge(vectorResults, graphResults);

      const factItem = result.items.find(i => i.nodeId === 'f1')!;
      expect(factItem.nodeType).toBe('fact');
      expect(factItem.sources).toContain('vector');
      expect(factItem.sources).toContain('graph');

      const episodeItem = result.items.find(i => i.nodeId === 'e1')!;
      expect(episodeItem.nodeType).toBe('episode');

      const conceptItem = result.items.find(i => i.nodeId === 'c1')!;
      expect(conceptItem.nodeType).toBe('concept');
    });
  });

  describe('merge — duplicate within same path', () => {
    it('keeps the higher score when same nodeId appears twice in one path', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        convergenceBonus: 0,
        minScore: 0,
      });

      const vectorResults = [vectorItem('a', 0.8), vectorItem('a', 0.3)];
      const result = merger.merge(vectorResults, []);

      // Should deduplicate, keeping the higher score
      expect(result.items).toHaveLength(1);
      expect(result.items[0].sourceScores.vector).toBe(0.8);
    });
  });

  describe('merge — statistics', () => {
    it('reports accurate merge statistics', () => {
      const merger = new ResultMerger({
        normalization: 'none',
        convergenceBonus: 0.1,
        minScore: 0.3,
        maxResults: 5,
      });

      const vectorResults = [
        vectorItem('a', 0.9),
        vectorItem('b', 0.7),
        vectorItem('c', 0.1), // will be filtered (0.5*0.1=0.05 < 0.3)
      ];
      const graphResults = [
        graphItem('a', 0.8),
        graphItem('d', 0.6),
      ];

      const result = merger.merge(vectorResults, graphResults);

      expect(result.stats.vectorInputCount).toBe(3);
      expect(result.stats.graphInputCount).toBe(2);
      expect(result.stats.overlapCount).toBe(1); // 'a'
      expect(result.stats.uniqueCount).toBe(4);  // a, b, c, d
      expect(result.stats.mergeTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});

// ─── Helper function tests ───────────────────────────────────

describe('minMaxNormalize', () => {
  it('normalizes scores to [0, 1] range', () => {
    const items: ScoredMemoryItem[] = [
      vectorItem('a', 0.2),
      vectorItem('b', 0.6),
      vectorItem('c', 1.0),
    ];

    const result = minMaxNormalize(items, 'vector');

    expect(result).toHaveLength(3);

    const scoreA = result.find(i => i.nodeId === 'a')!.score;
    const scoreB = result.find(i => i.nodeId === 'b')!.score;
    const scoreC = result.find(i => i.nodeId === 'c')!.score;

    expect(scoreA).toBeCloseTo(0.0, 5);
    expect(scoreB).toBeCloseTo(0.5, 5);
    expect(scoreC).toBeCloseTo(1.0, 5);
  });

  it('returns empty array for empty input', () => {
    expect(minMaxNormalize([], 'vector')).toEqual([]);
  });

  it('normalizes single item to 1.0', () => {
    const items = [vectorItem('a', 0.42)];
    const result = minMaxNormalize(items, 'vector');
    expect(result[0].score).toBe(1.0);
  });

  it('normalizes identical scores to 1.0', () => {
    const items = [vectorItem('a', 0.5), vectorItem('b', 0.5)];
    const result = minMaxNormalize(items, 'vector');
    expect(result[0].score).toBe(1.0);
    expect(result[1].score).toBe(1.0);
  });

  it('overrides source with provided source', () => {
    const items = [vectorItem('a', 0.5)];
    const result = minMaxNormalize(items, 'graph');
    expect(result[0].source).toBe('graph');
  });
});

describe('clamp01', () => {
  it('clamps values to [0, 1]', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1.0)).toBe(1);
    expect(clamp01(1.5)).toBe(1);
  });
});

describe('roundScore', () => {
  it('rounds to 4 decimal places', () => {
    expect(roundScore(0.12345)).toBe(0.1235);
    expect(roundScore(0.1)).toBe(0.1);
    expect(roundScore(0.99999)).toBe(1);
    expect(roundScore(0)).toBe(0);
  });
});
