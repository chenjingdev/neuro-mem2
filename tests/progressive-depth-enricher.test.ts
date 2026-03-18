/**
 * Tests for progressive depth enrichment via deepK parameter.
 *
 * AC 11: RecallQuery에 deepK 파라미터가 추가되어 상위 deepK개 노드는 L2까지,
 *         나머지는 L1만 반환
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ProgressiveDepthEnricher } from '../src/retrieval/progressive-depth-enricher.js';
import { MemoryNodeRepository } from '../src/db/memory-node-repo.js';
import { CREATE_MEMORY_NODE_TABLES } from '../src/db/memory-node-schema.js';
import type { MergedMemoryItem, ScoredMemoryItem, DepthLevel } from '../src/retrieval/types.js';
import type { CreateMemoryNodeInput, MemoryNodeMetadata } from '../src/models/memory-node.js';

// ─── Test Helpers ──────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(CREATE_MEMORY_NODE_TABLES);
  return db;
}

function makeMergedItem(nodeId: string, score: number): MergedMemoryItem {
  return {
    nodeId,
    nodeType: 'fact',
    score,
    content: `content for ${nodeId}`,
    sources: ['vector'],
    sourceScores: { vector: score },
  };
}

function makeScoredItem(nodeId: string, score: number): ScoredMemoryItem {
  return {
    nodeId,
    nodeType: 'fact',
    score,
    source: 'vector',
    content: `content for ${nodeId}`,
  };
}

function createNode(
  repo: MemoryNodeRepository,
  frontmatter: string,
  summary: string,
  metadata: MemoryNodeMetadata = {},
): string {
  const node = repo.create({
    nodeType: 'semantic',
    nodeRole: 'leaf',
    frontmatter,
    keywords: frontmatter.toLowerCase(),
    summary,
    metadata,
    sourceMessageIds: [],
  });
  return node.id;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('ProgressiveDepthEnricher', () => {
  let db: Database.Database;
  let repo: MemoryNodeRepository;
  let enricher: ProgressiveDepthEnricher;
  let nodeIds: string[];

  beforeEach(() => {
    db = createTestDb();
    repo = new MemoryNodeRepository(db);
    enricher = new ProgressiveDepthEnricher(db);

    // Create 5 test nodes with distinct metadata and summaries
    nodeIds = [
      createNode(repo, 'Node Alpha', 'Summary of Alpha node', {
        entities: ['alpha', 'test'],
        category: 'test',
        confidence: 0.95,
      }),
      createNode(repo, 'Node Beta', 'Summary of Beta node', {
        entities: ['beta'],
        category: 'test',
        confidence: 0.90,
      }),
      createNode(repo, 'Node Gamma', 'Summary of Gamma node', {
        entities: ['gamma'],
        category: 'experiment',
        confidence: 0.85,
      }),
      createNode(repo, 'Node Delta', 'Summary of Delta node', {
        entities: ['delta'],
        category: 'experiment',
        confidence: 0.80,
      }),
      createNode(repo, 'Node Epsilon', 'Summary of Epsilon node', {
        entities: ['epsilon'],
        category: 'misc',
        confidence: 0.75,
      }),
    ];
  });

  afterEach(() => {
    db.close();
  });

  // ── RecallQuery deepK interface ──

  it('RecallQuery interface accepts deepK parameter', async () => {
    // Type-level check: importing and using the interface
    const { RecallQuery } = await import('../src/retrieval/dual-path-retriever.js');
    // This is a compile-time check — if deepK isn't in the interface, TS would fail
    const query = {
      queryText: 'test',
      deepK: 3,
    } satisfies import('../src/retrieval/dual-path-retriever.js').RecallQuery;
    expect(query.deepK).toBe(3);
  });

  it('UnifiedRecallQuery interface accepts deepK parameter', async () => {
    const query = {
      text: 'test',
      deepK: 5,
    } satisfies import('../src/retrieval/unified-retriever.js').UnifiedRecallQuery;
    expect(query.deepK).toBe(5);
  });

  // ── MergedMemoryItem enrichment ──

  describe('enrichMergedItems', () => {
    it('returns items unchanged when deepK is 0', () => {
      const items = nodeIds.map((id, i) => makeMergedItem(id, 1 - i * 0.1));
      const result = enricher.enrichMergedItems(items, 0);

      expect(result.stats.l2Count).toBe(0);
      expect(result.stats.l1Count).toBe(0);
      expect(result.items[0]!.depthLevel).toBeUndefined();
    });

    it('returns items unchanged when deepK is undefined', () => {
      const items = nodeIds.map((id, i) => makeMergedItem(id, 1 - i * 0.1));
      const result = enricher.enrichMergedItems(items, undefined);

      expect(result.stats.l2Count).toBe(0);
      expect(result.stats.l1Count).toBe(0);
    });

    it('enriches top deepK items to L2 and rest to L1', () => {
      const items = nodeIds.map((id, i) => makeMergedItem(id, 1 - i * 0.1));
      const result = enricher.enrichMergedItems(items, 2);

      // Top 2 should be L2
      expect(result.items[0]!.depthLevel).toBe('L2');
      expect(result.items[1]!.depthLevel).toBe('L2');
      expect(result.items[0]!.summary).toBe('Summary of Alpha node');
      expect(result.items[1]!.summary).toBe('Summary of Beta node');
      expect(result.items[0]!.nodeMetadata).toBeDefined();
      expect(result.items[0]!.nodeMetadata?.entities).toEqual(['alpha', 'test']);
      expect(result.items[0]!.frontmatter).toBe('Node Alpha');

      // Remaining should be L1
      expect(result.items[2]!.depthLevel).toBe('L1');
      expect(result.items[3]!.depthLevel).toBe('L1');
      expect(result.items[4]!.depthLevel).toBe('L1');
      expect(result.items[2]!.summary).toBeUndefined();
      expect(result.items[2]!.nodeMetadata).toBeDefined();
      expect(result.items[2]!.nodeMetadata?.entities).toEqual(['gamma']);
      expect(result.items[2]!.frontmatter).toBe('Node Gamma');

      // Stats
      expect(result.stats.l2Count).toBe(2);
      expect(result.stats.l1Count).toBe(3);
      expect(result.stats.missingCount).toBe(0);
    });

    it('L2 items have enriched content (frontmatter + summary)', () => {
      const items = nodeIds.map((id, i) => makeMergedItem(id, 1 - i * 0.1));
      const result = enricher.enrichMergedItems(items, 1);

      // L2 item content should be enriched with summary
      expect(result.items[0]!.content).toBe('Node Alpha\nSummary of Alpha node');

      // L1 items should keep original content (or frontmatter if empty)
      expect(result.items[1]!.content).toBe(`content for ${nodeIds[1]}`);
    });

    it('deepK larger than items count enriches all to L2', () => {
      const items = nodeIds.slice(0, 3).map((id, i) => makeMergedItem(id, 1 - i * 0.1));
      const result = enricher.enrichMergedItems(items, 10);

      expect(result.items.every(i => i.depthLevel === 'L2')).toBe(true);
      expect(result.stats.l2Count).toBe(3);
      expect(result.stats.l1Count).toBe(0);
    });

    it('handles missing nodes gracefully (marks as L0)', () => {
      const items = [
        makeMergedItem(nodeIds[0]!, 0.9),
        makeMergedItem('nonexistent-id', 0.8),
        makeMergedItem(nodeIds[2]!, 0.7),
      ];
      const result = enricher.enrichMergedItems(items, 2);

      expect(result.items[0]!.depthLevel).toBe('L2');
      expect(result.items[1]!.depthLevel).toBe('L0'); // missing → L0
      expect(result.items[2]!.depthLevel).toBe('L1');
      expect(result.stats.missingCount).toBe(1);
    });

    it('returns enrichment timing stats', () => {
      const items = nodeIds.map((id, i) => makeMergedItem(id, 1 - i * 0.1));
      const result = enricher.enrichMergedItems(items, 3);

      expect(result.stats.enrichTimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.stats.enrichTimeMs).toBe('number');
    });

    it('handles empty items array', () => {
      const result = enricher.enrichMergedItems([], 5);

      expect(result.items).toHaveLength(0);
      expect(result.stats.l2Count).toBe(0);
      expect(result.stats.l1Count).toBe(0);
    });

    it('handles deepK = 1 (single top item gets L2)', () => {
      const items = nodeIds.map((id, i) => makeMergedItem(id, 1 - i * 0.1));
      const result = enricher.enrichMergedItems(items, 1);

      expect(result.items[0]!.depthLevel).toBe('L2');
      for (let i = 1; i < items.length; i++) {
        expect(result.items[i]!.depthLevel).toBe('L1');
      }
      expect(result.stats.l2Count).toBe(1);
      expect(result.stats.l1Count).toBe(4);
    });
  });

  // ── ScoredMemoryItem enrichment ──

  describe('enrichScoredItems', () => {
    it('enriches top deepK scored items to L2 and rest to L1', () => {
      const items = nodeIds.map((id, i) => makeScoredItem(id, 1 - i * 0.1));
      const result = enricher.enrichScoredItems(items, 3);

      // Top 3 L2
      for (let i = 0; i < 3; i++) {
        expect(result.items[i]!.depthLevel).toBe('L2');
        expect(result.items[i]!.summary).toBeDefined();
        expect(result.items[i]!.nodeMetadata).toBeDefined();
        expect(result.items[i]!.frontmatter).toBeDefined();
      }

      // Remaining L1
      for (let i = 3; i < 5; i++) {
        expect(result.items[i]!.depthLevel).toBe('L1');
        expect(result.items[i]!.summary).toBeUndefined();
        expect(result.items[i]!.nodeMetadata).toBeDefined();
      }

      expect(result.stats.l2Count).toBe(3);
      expect(result.stats.l1Count).toBe(2);
    });

    it('returns items unchanged when deepK is undefined', () => {
      const items = nodeIds.map((id, i) => makeScoredItem(id, 1 - i * 0.1));
      const result = enricher.enrichScoredItems(items);

      expect(result.items[0]!.depthLevel).toBeUndefined();
      expect(result.stats.l2Count).toBe(0);
    });
  });

  // ── 한영 혼용 support ──

  describe('Korean/English mixed content', () => {
    it('enriches nodes with Korean content correctly', () => {
      const koreanNodeId = createNode(
        repo,
        '사용자 선호도',
        '사용자는 TypeScript와 함수형 프로그래밍을 선호합니다',
        { entities: ['TypeScript', '함수형 프로그래밍'], category: '선호도' },
      );

      const items = [makeMergedItem(koreanNodeId, 0.9)];
      const result = enricher.enrichMergedItems(items, 1);

      expect(result.items[0]!.depthLevel).toBe('L2');
      expect(result.items[0]!.frontmatter).toBe('사용자 선호도');
      expect(result.items[0]!.summary).toBe('사용자는 TypeScript와 함수형 프로그래밍을 선호합니다');
      expect(result.items[0]!.nodeMetadata?.entities).toEqual(['TypeScript', '함수형 프로그래밍']);
    });
  });

  // ── DepthLevel type ──

  describe('DepthLevel type values', () => {
    it('DepthLevel values are correctly typed', () => {
      const levels: DepthLevel[] = ['L0', 'L1', 'L2', 'L3'];
      expect(levels).toHaveLength(4);
    });
  });

  // ── RecallDiagnostics enrichmentStats ──

  describe('RecallDiagnostics enrichmentStats', () => {
    it('RecallDiagnostics includes optional enrichmentStats field', async () => {
      // Type check: ensure the field exists on the interface
      const diagnostics: import('../src/retrieval/dual-path-retriever.js').RecallDiagnostics = {
        activatedAnchors: [],
        extractedEntities: [],
        graphSeedCount: 0,
        vectorTimeMs: 0,
        graphTimeMs: 0,
        totalTimeMs: 0,
        vectorItemCount: 0,
        graphItemCount: 0,
        mergeStats: {
          vectorInputCount: 0,
          graphInputCount: 0,
          overlapCount: 0,
          uniqueCount: 0,
          filteredCount: 0,
          outputCount: 0,
          mergeTimeMs: 0,
        },
        edgesReinforced: 0,
        vectorTimedOut: false,
        graphTimedOut: false,
        enrichmentStats: {
          l2Count: 3,
          l1Count: 7,
          missingCount: 0,
          enrichTimeMs: 1.5,
        },
      };

      expect(diagnostics.enrichmentStats?.l2Count).toBe(3);
      expect(diagnostics.enrichmentStats?.l1Count).toBe(7);
    });
  });

  // ── Integration: context content quality ──

  describe('content enrichment for context injection', () => {
    it('L2 items provide richer content than L1 items for the same node', () => {
      const items = [
        makeMergedItem(nodeIds[0]!, 0.95),
        makeMergedItem(nodeIds[0]!, 0.85), // duplicate for comparison
      ];
      // But we need different items. Let's use two different nodes
      items[1]!.nodeId = nodeIds[1]!;

      const resultDeep2 = enricher.enrichMergedItems(
        [makeMergedItem(nodeIds[0]!, 0.95)],
        1,
      );
      const resultDeep0 = enricher.enrichMergedItems(
        [makeMergedItem(nodeIds[0]!, 0.95)],
        0,
      );

      // L2 enrichment provides summary in content
      expect(resultDeep2.items[0]!.content).toContain('Summary of Alpha node');
      // Without enrichment, content stays as original
      expect(resultDeep0.items[0]!.content).toBe(`content for ${nodeIds[0]}`);
    });
  });
});
