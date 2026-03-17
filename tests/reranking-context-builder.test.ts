/**
 * Tests for RerankingContextBuilder — collects facts connected to top-K anchors
 * and constructs context for LLM re-ranking.
 *
 * Sub-AC 1 of AC 10: top-K anchor에 연결된 fact들을 수집하여
 * LLM re-ranking용 context를 구성하는 함수 구현
 *
 * Tests cover:
 *   1. Basic fact collection from anchor → weighted_edge → fact
 *   2. Multi-anchor fact deduplication (same fact from multiple anchors)
 *   3. Edge weight ordering (higher weight facts rank first)
 *   4. Combined score ranking (anchor similarity * edge weight)
 *   5. maxFactsPerAnchor limit
 *   6. maxTotalFacts global limit
 *   7. minEdgeWeight filtering
 *   8. Multi-level content (frontmatter / summary / full)
 *   9. Edge metadata inclusion in context
 *  10. formatForLLM output structure
 *  11. Empty cases (no anchors, no edges, no facts)
 *  12. Superseded facts are excluded
 *  13. Stats / pipeline traceability
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import {
  RerankingContextBuilder,
  type RerankingContext,
} from '../src/retrieval/reranking-context-builder.js';
import type { AnchorMatch } from '../src/retrieval/vector-searcher.js';
import type Database from 'better-sqlite3';

// ─── Test Helpers ────────────────────────────────────────────────

const DIM = 8;

function toFloat32(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

function unitVector(dim: number, index: number): number[] {
  const v = new Array(dim).fill(0);
  v[index] = 1.0;
  return v;
}

// ─── Test Setup ──────────────────────────────────────────────────

describe('RerankingContextBuilder', () => {
  let db: Database.Database;
  let anchorRepo: AnchorRepository;
  let edgeRepo: WeightedEdgeRepository;
  let factRepo: FactRepository;
  let convRepo: ConversationRepository;
  let conversationId: string;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    anchorRepo = new AnchorRepository(db);
    edgeRepo = new WeightedEdgeRepository(db);
    factRepo = new FactRepository(db);
    convRepo = new ConversationRepository(db);
    conversationId = convRepo.ingest({ source: 'test', messages: [] }).id;
  });

  function createAnchor(label: string, description: string): string {
    return anchorRepo.createAnchor({
      label,
      description,
      anchorType: 'topic',
      embedding: toFloat32(unitVector(DIM, 0)),
      initialWeight: 1.0,
      decayRate: 0,
    }).id;
  }

  function createFact(
    content: string,
    opts?: { summary?: string; frontmatter?: string },
  ): string {
    const fact = factRepo.create({
      content,
      conversationId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: [],
    });
    if (opts?.summary || opts?.frontmatter) {
      factRepo.updateSummaries([{
        id: fact.id,
        summary: opts.summary ?? '',
        frontmatter: opts.frontmatter ?? '',
      }]);
    }
    return fact.id;
  }

  function linkAnchorToFact(
    anchorId: string,
    factId: string,
    weight: number,
    activationCount = 0,
  ) {
    return edgeRepo.createEdge({
      sourceId: anchorId,
      sourceType: 'anchor',
      targetId: factId,
      targetType: 'fact',
      edgeType: 'anchor_to_fact',
      weight,
      initialWeight: weight,
      learningRate: 0.1,
      decayRate: 0,
    });
  }

  function makeAnchorMatch(
    anchorId: string,
    label: string,
    similarity: number,
  ): AnchorMatch {
    return { anchorId, label, similarity, expandedNodeCount: 0 };
  }

  // ── 1. Basic fact collection ──

  describe('basic fact collection', () => {
    it('collects facts connected to an anchor via weighted edges', () => {
      const anchorId = createAnchor('TypeScript', 'TS programming');
      const factId = createFact('TypeScript uses static typing');
      linkAnchorToFact(anchorId, factId, 0.8);

      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext(
        'TypeScript features',
        [makeAnchorMatch(anchorId, 'TypeScript', 0.9)],
      );

      expect(ctx.rankedFacts).toHaveLength(1);
      expect(ctx.rankedFacts[0].factId).toBe(factId);
      expect(ctx.rankedFacts[0].content).toBe('TypeScript uses static typing');
      expect(ctx.rankedFacts[0].edgeWeight).toBe(0.8);
      expect(ctx.rankedFacts[0].category).toBe('technical');
    });

    it('collects facts from multiple anchors', () => {
      const anchor1 = createAnchor('TypeScript', 'TS');
      const anchor2 = createAnchor('JavaScript', 'JS');
      const fact1 = createFact('TypeScript compiles to JS');
      const fact2 = createFact('JavaScript runs in the browser');
      linkAnchorToFact(anchor1, fact1, 0.8);
      linkAnchorToFact(anchor2, fact2, 0.7);

      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext('web development', [
        makeAnchorMatch(anchor1, 'TypeScript', 0.9),
        makeAnchorMatch(anchor2, 'JavaScript', 0.8),
      ]);

      expect(ctx.rankedFacts).toHaveLength(2);
      expect(ctx.anchorContexts).toHaveLength(2);
    });
  });

  // ── 2. Deduplication ──

  describe('deduplication', () => {
    it('deduplicates facts reachable from multiple anchors', () => {
      const anchor1 = createAnchor('TypeScript', 'TS');
      const anchor2 = createAnchor('Static Typing', 'Types');
      const factId = createFact('TypeScript uses static typing');
      linkAnchorToFact(anchor1, factId, 0.8);
      linkAnchorToFact(anchor2, factId, 0.6);

      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext('type systems', [
        makeAnchorMatch(anchor1, 'TypeScript', 0.9),
        makeAnchorMatch(anchor2, 'Static Typing', 0.85),
      ]);

      // Only 1 fact in global list (deduplicated)
      expect(ctx.rankedFacts).toHaveLength(1);
      // But accessible from both anchor contexts
      expect(ctx.anchorContexts[0].facts).toHaveLength(1);
      expect(ctx.anchorContexts[1].facts).toHaveLength(1);
      // Both source anchors recorded
      expect(ctx.rankedFacts[0].sourceAnchors).toHaveLength(2);
      // Keeps highest edge weight
      expect(ctx.rankedFacts[0].edgeWeight).toBe(0.8);
    });
  });

  // ── 3. Edge weight ordering ──

  describe('ranking', () => {
    it('ranks facts by combined score (similarity * edgeWeight)', () => {
      const anchorId = createAnchor('TypeScript', 'TS');
      const factHigh = createFact('High relevance fact');
      const factLow = createFact('Low relevance fact');
      linkAnchorToFact(anchorId, factHigh, 0.9);
      linkAnchorToFact(anchorId, factLow, 0.2);

      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext('TypeScript', [
        makeAnchorMatch(anchorId, 'TypeScript', 0.95),
      ]);

      expect(ctx.rankedFacts).toHaveLength(2);
      expect(ctx.rankedFacts[0].content).toBe('High relevance fact');
      expect(ctx.rankedFacts[1].content).toBe('Low relevance fact');
    });

    it('cross-anchor ranking: high-sim-low-edge < low-sim-high-edge scenario', () => {
      const anchor1 = createAnchor('Anchor A', 'A');
      const anchor2 = createAnchor('Anchor B', 'B');
      const fact1 = createFact('Fact from A');
      const fact2 = createFact('Fact from B');
      // anchor1 sim=0.5, edge=0.9 → score=0.45
      // anchor2 sim=0.9, edge=0.9 → score=0.81
      linkAnchorToFact(anchor1, fact1, 0.9);
      linkAnchorToFact(anchor2, fact2, 0.9);

      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext('test', [
        makeAnchorMatch(anchor1, 'Anchor A', 0.5),
        makeAnchorMatch(anchor2, 'Anchor B', 0.9),
      ]);

      expect(ctx.rankedFacts[0].content).toBe('Fact from B');
      expect(ctx.rankedFacts[1].content).toBe('Fact from A');
    });
  });

  // ── 4. Limits ──

  describe('limits', () => {
    it('respects maxFactsPerAnchor', () => {
      const anchorId = createAnchor('TypeScript', 'TS');
      for (let i = 0; i < 10; i++) {
        const fId = createFact(`Fact ${i}`);
        linkAnchorToFact(anchorId, fId, 0.9 - i * 0.05);
      }

      const builder = new RerankingContextBuilder(db, {
        maxFactsPerAnchor: 3,
      });
      const ctx = builder.buildContext('TypeScript', [
        makeAnchorMatch(anchorId, 'TypeScript', 0.9),
      ]);

      expect(ctx.rankedFacts.length).toBeLessThanOrEqual(3);
    });

    it('respects maxTotalFacts', () => {
      const anchor1 = createAnchor('A', 'A desc');
      const anchor2 = createAnchor('B', 'B desc');
      for (let i = 0; i < 5; i++) {
        const f1 = createFact(`A-Fact ${i}`);
        const f2 = createFact(`B-Fact ${i}`);
        linkAnchorToFact(anchor1, f1, 0.8);
        linkAnchorToFact(anchor2, f2, 0.7);
      }

      const builder = new RerankingContextBuilder(db, {
        maxTotalFacts: 4,
      });
      const ctx = builder.buildContext('test', [
        makeAnchorMatch(anchor1, 'A', 0.9),
        makeAnchorMatch(anchor2, 'B', 0.8),
      ]);

      expect(ctx.rankedFacts.length).toBeLessThanOrEqual(4);
    });

    it('respects minEdgeWeight', () => {
      const anchorId = createAnchor('TypeScript', 'TS');
      const factAbove = createFact('Above threshold');
      const factBelow = createFact('Below threshold');
      linkAnchorToFact(anchorId, factAbove, 0.5);
      linkAnchorToFact(anchorId, factBelow, 0.01);

      const builder = new RerankingContextBuilder(db, {
        minEdgeWeight: 0.1,
      });
      const ctx = builder.buildContext('TypeScript', [
        makeAnchorMatch(anchorId, 'TypeScript', 0.9),
      ]);

      expect(ctx.rankedFacts).toHaveLength(1);
      expect(ctx.rankedFacts[0].content).toBe('Above threshold');
    });
  });

  // ── 5. Multi-level content ──

  describe('multi-level content', () => {
    it('includes frontmatter and summary when available', () => {
      const anchorId = createAnchor('TypeScript', 'TS');
      const factId = createFact('TypeScript uses static typing for compile-time safety', {
        summary: 'TS provides static typing',
        frontmatter: 'TS: static typing',
      });
      linkAnchorToFact(anchorId, factId, 0.8);

      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext('TypeScript', [
        makeAnchorMatch(anchorId, 'TypeScript', 0.9),
      ]);

      const fact = ctx.rankedFacts[0];
      expect(fact.frontmatter).toBe('TS: static typing');
      expect(fact.summary).toBe('TS provides static typing');
      expect(fact.content).toBe('TypeScript uses static typing for compile-time safety');
    });

    it('handles facts without summary/frontmatter gracefully', () => {
      const anchorId = createAnchor('TypeScript', 'TS');
      const factId = createFact('Just content, no summary');
      linkAnchorToFact(anchorId, factId, 0.8);

      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext('TypeScript', [
        makeAnchorMatch(anchorId, 'TypeScript', 0.9),
      ]);

      expect(ctx.rankedFacts[0].frontmatter).toBeUndefined();
      expect(ctx.rankedFacts[0].summary).toBeUndefined();
      expect(ctx.rankedFacts[0].content).toBe('Just content, no summary');
    });
  });

  // ── 6. formatForLLM ──

  describe('formatForLLM', () => {
    it('produces structured text for LLM consumption', () => {
      const anchorId = createAnchor('TypeScript', 'TS');
      const factId = createFact('TypeScript uses static typing', {
        summary: 'TS has static types',
      });
      linkAnchorToFact(anchorId, factId, 0.8);

      const builder = new RerankingContextBuilder(db, {
        detailLevel: 'summary',
      });
      const ctx = builder.buildContext('TypeScript features', [
        makeAnchorMatch(anchorId, 'TypeScript', 0.9),
      ]);

      const formatted = builder.formatForLLM(ctx);

      expect(formatted).toContain('Query: "TypeScript features"');
      expect(formatted).toContain('Activated anchors: 1');
      expect(formatted).toContain('Candidate facts: 1');
      // Summary level: shows summary instead of full content
      expect(formatted).toContain('Content: TS has static types');
      expect(formatted).toContain('Category: technical');
      expect(formatted).toContain('Edge weight:');
      expect(formatted).toContain('Via anchors: TypeScript');
    });

    it('uses frontmatter level when configured', () => {
      const anchorId = createAnchor('TypeScript', 'TS');
      createFact('Full content here', {
        frontmatter: 'FM: short label',
        summary: 'A summary',
      });
      const factId2 = createFact('Another fact without levels');
      // Link fact with levels
      const factWithLevels = db.prepare(
        "SELECT id FROM facts WHERE content = 'Full content here'",
      ).get() as { id: string };
      linkAnchorToFact(anchorId, factWithLevels.id, 0.8);
      linkAnchorToFact(anchorId, factId2, 0.7);

      const builder = new RerankingContextBuilder(db, {
        detailLevel: 'frontmatter',
      });
      const ctx = builder.buildContext('test', [
        makeAnchorMatch(anchorId, 'TypeScript', 0.9),
      ]);

      const formatted = builder.formatForLLM(ctx);

      // Fact with frontmatter shows frontmatter
      expect(formatted).toContain('Content: FM: short label');
      // Fact without frontmatter falls back to content
      expect(formatted).toContain('Content: Another fact without levels');
    });

    it('omits edge metadata when includeEdgeMetadata is false', () => {
      const anchorId = createAnchor('TypeScript', 'TS');
      const factId = createFact('Some fact');
      linkAnchorToFact(anchorId, factId, 0.8);

      const builder = new RerankingContextBuilder(db, {
        includeEdgeMetadata: false,
      });
      const ctx = builder.buildContext('test', [
        makeAnchorMatch(anchorId, 'TypeScript', 0.9),
      ]);

      const formatted = builder.formatForLLM(ctx);
      expect(formatted).not.toContain('Edge weight:');
      expect(formatted).not.toContain('Activations:');
    });
  });

  // ── 7. Empty / edge cases ──

  describe('edge cases', () => {
    it('returns empty context when no anchors provided', () => {
      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext('anything', []);

      expect(ctx.rankedFacts).toHaveLength(0);
      expect(ctx.anchorContexts).toHaveLength(0);
      expect(ctx.stats.anchorsProcessed).toBe(0);
    });

    it('returns empty context when anchor has no connected facts', () => {
      const anchorId = createAnchor('TypeScript', 'TS');

      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext('TypeScript', [
        makeAnchorMatch(anchorId, 'TypeScript', 0.9),
      ]);

      expect(ctx.rankedFacts).toHaveLength(0);
      expect(ctx.anchorContexts).toHaveLength(1);
      expect(ctx.anchorContexts[0].facts).toHaveLength(0);
    });

    it('excludes superseded facts', () => {
      const anchorId = createAnchor('TypeScript', 'TS');
      const oldFactId = createFact('Old info');
      const newFactId = createFact('New info');
      linkAnchorToFact(anchorId, oldFactId, 0.8);
      linkAnchorToFact(anchorId, newFactId, 0.9);

      // Supersede the old fact
      factRepo.supersede(oldFactId, newFactId);

      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext('TypeScript', [
        makeAnchorMatch(anchorId, 'TypeScript', 0.9),
      ]);

      expect(ctx.rankedFacts).toHaveLength(1);
      expect(ctx.rankedFacts[0].content).toBe('New info');
    });
  });

  // ── 8. Stats / pipeline traceability ──

  describe('stats and traceability', () => {
    it('reports accurate statistics', () => {
      const anchor1 = createAnchor('A', 'A desc');
      const anchor2 = createAnchor('B', 'B desc');
      const fact1 = createFact('Fact 1');
      const fact2 = createFact('Fact 2');
      const sharedFact = createFact('Shared fact');
      linkAnchorToFact(anchor1, fact1, 0.8);
      linkAnchorToFact(anchor1, sharedFact, 0.7);
      linkAnchorToFact(anchor2, fact2, 0.6);
      linkAnchorToFact(anchor2, sharedFact, 0.5);

      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext('test', [
        makeAnchorMatch(anchor1, 'A', 0.9),
        makeAnchorMatch(anchor2, 'B', 0.8),
      ]);

      expect(ctx.stats.anchorsProcessed).toBe(2);
      expect(ctx.stats.edgesTraversed).toBe(4); // 2 from A + 2 from B
      expect(ctx.stats.factsFoundRaw).toBe(4); // 4 edge traversals
      expect(ctx.stats.factsDeduped).toBe(3); // 3 unique facts
      expect(ctx.stats.factsOutput).toBe(3);
      expect(ctx.stats.buildTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('preserves query in context', () => {
      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext('my specific query', []);
      expect(ctx.query).toBe('my specific query');
    });
  });

  // ── 9. Source anchor tracking ──

  describe('source anchor tracking', () => {
    it('tracks which anchors led to each fact', () => {
      const anchor1 = createAnchor('A', 'A desc');
      const anchor2 = createAnchor('B', 'B desc');
      const factId = createFact('Shared fact');
      linkAnchorToFact(anchor1, factId, 0.8);
      linkAnchorToFact(anchor2, factId, 0.6);

      const builder = new RerankingContextBuilder(db);
      const ctx = builder.buildContext('test', [
        makeAnchorMatch(anchor1, 'A', 0.9),
        makeAnchorMatch(anchor2, 'B', 0.85),
      ]);

      const fact = ctx.rankedFacts[0];
      expect(fact.sourceAnchors).toHaveLength(2);

      const labels = fact.sourceAnchors.map(a => a.anchorLabel).sort();
      expect(labels).toEqual(['A', 'B']);

      const anchorA = fact.sourceAnchors.find(a => a.anchorLabel === 'A')!;
      expect(anchorA.similarity).toBe(0.9);
      expect(anchorA.edgeWeight).toBe(0.8);
    });
  });
});
