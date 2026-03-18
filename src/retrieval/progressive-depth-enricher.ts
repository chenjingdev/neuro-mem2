/**
 * ProgressiveDepthEnricher — applies deepK-based progressive depth enrichment
 * to ranked retrieval results.
 *
 * Given a ranked list of items and a deepK parameter:
 *   - Top deepK items → enriched to L2 (frontmatter + metadata + summary)
 *   - Remaining items → enriched to L1 (frontmatter + metadata only)
 *
 * This implements the 4-layer progressive depth retrieval strategy:
 *   L0: frontmatter + keywords (already in content field from retrieval)
 *   L1: + structured metadata (entities, category, confidence, SPO triples, etc.)
 *   L2: + human-readable summary
 *   L3: + source turn references (not included in recall results — for traceability UI only)
 *
 * Usage:
 *   const enricher = new ProgressiveDepthEnricher(db);
 *   const enriched = enricher.enrichItems(rankedItems, deepK);
 */

import type Database from 'better-sqlite3';
import { MemoryNodeRepository } from '../db/memory-node-repo.js';
import type { MemoryNodeL1, MemoryNodeL2 } from '../models/memory-node.js';
import type { MergedMemoryItem, ScoredMemoryItem, DepthLevel } from './types.js';

// ─── Enrichment Result ──────────────────────────────────────────

export interface EnrichmentStats {
  /** Number of items enriched to L2 */
  l2Count: number;
  /** Number of items enriched to L1 */
  l1Count: number;
  /** Number of items that could not be enriched (missing from DB) */
  missingCount: number;
  /** Time taken for enrichment (ms) */
  enrichTimeMs: number;
}

// ─── ProgressiveDepthEnricher ───────────────────────────────────

export class ProgressiveDepthEnricher {
  private repo: MemoryNodeRepository;

  constructor(db: Database.Database) {
    this.repo = new MemoryNodeRepository(db);
  }

  /**
   * Enrich MergedMemoryItems with progressive depth data.
   *
   * @param items - Ranked list of merged items (must already be sorted by score desc)
   * @param deepK - Number of top items to enrich to L2; rest get L1.
   *                If 0 or undefined, no enrichment is applied.
   * @returns The same items array with depth fields populated (mutated in place for performance)
   */
  enrichMergedItems(
    items: MergedMemoryItem[],
    deepK?: number,
  ): { items: MergedMemoryItem[]; stats: EnrichmentStats } {
    const start = performance.now();

    if (!deepK || deepK <= 0 || items.length === 0) {
      return {
        items,
        stats: { l2Count: 0, l1Count: 0, missingCount: 0, enrichTimeMs: 0 },
      };
    }

    const effectiveDeepK = Math.min(deepK, items.length);

    // Split items into L2 (top deepK) and L1 (rest) groups
    const l2Ids = items.slice(0, effectiveDeepK).map(i => i.nodeId);
    const l1Ids = items.slice(effectiveDeepK).map(i => i.nodeId);

    // Batch-fetch L2 and L1 data from the repository
    const l2Map = new Map<string, MemoryNodeL2>();
    const l1Map = new Map<string, MemoryNodeL1>();

    if (l2Ids.length > 0) {
      const l2Nodes = this.repo.getL2ByIds(l2Ids);
      for (const node of l2Nodes) {
        l2Map.set(node.id, node);
      }
    }

    if (l1Ids.length > 0) {
      const l1Nodes = this.repo.getL1ByIds(l1Ids);
      for (const node of l1Nodes) {
        l1Map.set(node.id, node);
      }
    }

    // Apply enrichment to items
    let missingCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;

      if (i < effectiveDeepK) {
        // Top deepK → L2 enrichment
        const l2 = l2Map.get(item.nodeId);
        if (l2) {
          item.depthLevel = 'L2';
          item.nodeMetadata = l2.metadata;
          item.summary = l2.summary;
          item.frontmatter = l2.frontmatter;
          // Enrich content with summary for context injection
          if (l2.summary && l2.summary.trim()) {
            item.content = `${l2.frontmatter}\n${l2.summary}`;
          }
        } else {
          missingCount++;
          item.depthLevel = 'L0';
        }
      } else {
        // Remaining → L1 enrichment
        const l1 = l1Map.get(item.nodeId);
        if (l1) {
          item.depthLevel = 'L1';
          item.nodeMetadata = l1.metadata;
          item.frontmatter = l1.frontmatter;
          // Keep existing content but ensure frontmatter is available
          if (!item.content || item.content.trim().length === 0) {
            item.content = l1.frontmatter;
          }
        } else {
          missingCount++;
          item.depthLevel = 'L0';
        }
      }
    }

    const enrichTimeMs = Math.round((performance.now() - start) * 100) / 100;

    return {
      items,
      stats: {
        l2Count: l2Ids.length - (l2Ids.length > 0 ? countMissing(l2Ids, l2Map) : 0),
        l1Count: l1Ids.length - (l1Ids.length > 0 ? countMissing(l1Ids, l1Map) : 0),
        missingCount,
        enrichTimeMs,
      },
    };
  }

  /**
   * Enrich ScoredMemoryItems with progressive depth data.
   * Same logic as enrichMergedItems but for pre-merge items.
   */
  enrichScoredItems(
    items: ScoredMemoryItem[],
    deepK?: number,
  ): { items: ScoredMemoryItem[]; stats: EnrichmentStats } {
    const start = performance.now();

    if (!deepK || deepK <= 0 || items.length === 0) {
      return {
        items,
        stats: { l2Count: 0, l1Count: 0, missingCount: 0, enrichTimeMs: 0 },
      };
    }

    const effectiveDeepK = Math.min(deepK, items.length);

    const l2Ids = items.slice(0, effectiveDeepK).map(i => i.nodeId);
    const l1Ids = items.slice(effectiveDeepK).map(i => i.nodeId);

    const l2Map = new Map<string, MemoryNodeL2>();
    const l1Map = new Map<string, MemoryNodeL1>();

    if (l2Ids.length > 0) {
      for (const node of this.repo.getL2ByIds(l2Ids)) {
        l2Map.set(node.id, node);
      }
    }

    if (l1Ids.length > 0) {
      for (const node of this.repo.getL1ByIds(l1Ids)) {
        l1Map.set(node.id, node);
      }
    }

    let missingCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;

      if (i < effectiveDeepK) {
        const l2 = l2Map.get(item.nodeId);
        if (l2) {
          item.depthLevel = 'L2';
          item.nodeMetadata = l2.metadata;
          item.summary = l2.summary;
          item.frontmatter = l2.frontmatter;
          if (l2.summary && l2.summary.trim()) {
            item.content = `${l2.frontmatter}\n${l2.summary}`;
          }
        } else {
          missingCount++;
          item.depthLevel = 'L0';
        }
      } else {
        const l1 = l1Map.get(item.nodeId);
        if (l1) {
          item.depthLevel = 'L1';
          item.nodeMetadata = l1.metadata;
          item.frontmatter = l1.frontmatter;
          if (!item.content || item.content.trim().length === 0) {
            item.content = l1.frontmatter;
          }
        } else {
          missingCount++;
          item.depthLevel = 'L0';
        }
      }
    }

    const enrichTimeMs = Math.round((performance.now() - start) * 100) / 100;

    return {
      items,
      stats: {
        l2Count: l2Ids.length - countMissing(l2Ids, l2Map),
        l1Count: l1Ids.length - countMissing(l1Ids, l1Map),
        missingCount,
        enrichTimeMs,
      },
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function countMissing(ids: string[], map: Map<string, unknown>): number {
  let count = 0;
  for (const id of ids) {
    if (!map.has(id)) count++;
  }
  return count;
}
