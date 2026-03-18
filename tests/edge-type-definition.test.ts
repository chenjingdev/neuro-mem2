/**
 * Tests for AC 4: edgeType defined as 'about'|'related'|'caused'|'precedes'|'refines'|'contradicts'
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import {
  WEIGHTED_EDGE_TYPES,
  type WeightedEdgeType,
  type CreateWeightedEdgeInput,
} from '../src/models/weighted-edge.js';
import { CREATE_ANCHOR_TABLES } from '../src/db/anchor-schema.js';

describe('EdgeType Definition (AC 4)', () => {
  let db: Database.Database;
  let repo: WeightedEdgeRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(CREATE_ANCHOR_TABLES);
    repo = new WeightedEdgeRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('WEIGHTED_EDGE_TYPES contains exactly the 6 defined types', () => {
    expect(WEIGHTED_EDGE_TYPES).toEqual([
      'about',
      'related',
      'caused',
      'precedes',
      'refines',
      'contradicts',
    ]);
    expect(WEIGHTED_EDGE_TYPES).toHaveLength(6);
  });

  it('WeightedEdgeType type allows only the 6 valid values', () => {
    // Type-level check: these assignments should compile
    const validTypes: WeightedEdgeType[] = [
      'about',
      'related',
      'caused',
      'precedes',
      'refines',
      'contradicts',
    ];
    expect(validTypes).toHaveLength(6);

    // Each value should be in WEIGHTED_EDGE_TYPES
    for (const t of validTypes) {
      expect(WEIGHTED_EDGE_TYPES).toContain(t);
    }
  });

  it('can create edges with each of the 6 edge types', () => {
    const edgeTypes: WeightedEdgeType[] = [
      'about',
      'related',
      'caused',
      'precedes',
      'refines',
      'contradicts',
    ];

    for (const edgeType of edgeTypes) {
      const input: CreateWeightedEdgeInput = {
        sourceId: `source-${edgeType}`,
        sourceType: 'leaf',
        targetId: `target-${edgeType}`,
        targetType: 'hub',
        edgeType,
        weight: 50,
      };

      const edge = repo.createEdge(input);
      expect(edge.edgeType).toBe(edgeType);
      expect(edge.sourceType).toBe('leaf');
      expect(edge.targetType).toBe('hub');
    }

    expect(repo.countEdges()).toBe(6);
  });

  it('rejects invalid edge types at the DB level', () => {
    // The SQLite CHECK constraint should reject old/invalid edge types
    const invalidTypes = [
      'episode_mentions_concept',
      'anchor_to_fact',
      'query_activated',
      'invalid_type',
      'temporal_next',
    ];

    for (const badType of invalidTypes) {
      expect(() => {
        db.prepare(`
          INSERT INTO weighted_edges (id, source_id, source_type, target_id, target_type,
            edge_type, weight, initial_weight, shield, learning_rate, decay_rate,
            activation_count, last_activated_at_event, created_at, updated_at)
          VALUES (?, ?, 'hub', ?, 'leaf', ?, 50, 50, 0, 0.1, 0.01, 0, 0, ?, ?)
        `).run(
          `id-${badType}`,
          `src-${badType}`,
          `tgt-${badType}`,
          badType,
          new Date().toISOString(),
          new Date().toISOString(),
        );
      }).toThrow();
    }
  });

  it('source_type and target_type accept hub and leaf', () => {
    const combos: Array<{ srcType: 'hub' | 'leaf'; tgtType: 'hub' | 'leaf' }> = [
      { srcType: 'hub', tgtType: 'hub' },
      { srcType: 'hub', tgtType: 'leaf' },
      { srcType: 'leaf', tgtType: 'hub' },
      { srcType: 'leaf', tgtType: 'leaf' },
    ];

    for (const { srcType, tgtType } of combos) {
      const edge = repo.createEdge({
        sourceId: `src-${srcType}-${tgtType}`,
        sourceType: srcType,
        targetId: `tgt-${srcType}-${tgtType}`,
        targetType: tgtType,
        edgeType: 'related',
      });
      expect(edge.sourceType).toBe(srcType);
      expect(edge.targetType).toBe(tgtType);
    }
  });

  it('rejects old node types (episode, concept, fact, anchor) at DB level', () => {
    const oldTypes = ['episode', 'concept', 'fact', 'anchor'];

    for (const oldType of oldTypes) {
      expect(() => {
        db.prepare(`
          INSERT INTO weighted_edges (id, source_id, source_type, target_id, target_type,
            edge_type, weight, initial_weight, shield, learning_rate, decay_rate,
            activation_count, last_activated_at_event, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'hub', 'about', 50, 50, 0, 0.1, 0.01, 0, 0, ?, ?)
        `).run(
          `id-old-${oldType}`,
          `src-old-${oldType}`,
          oldType,
          `tgt-old-${oldType}`,
          new Date().toISOString(),
          new Date().toISOString(),
        );
      }).toThrow();
    }
  });

  it('can filter edges by the new edge types', () => {
    // Create edges with different types
    repo.createEdge({ sourceId: 's1', sourceType: 'leaf', targetId: 't1', targetType: 'hub', edgeType: 'about' });
    repo.createEdge({ sourceId: 's2', sourceType: 'leaf', targetId: 't2', targetType: 'hub', edgeType: 'caused' });
    repo.createEdge({ sourceId: 's3', sourceType: 'leaf', targetId: 't3', targetType: 'hub', edgeType: 'contradicts' });

    const aboutEdges = repo.queryEdges({ edgeTypes: ['about'] });
    expect(aboutEdges).toHaveLength(1);
    expect(aboutEdges[0].edgeType).toBe('about');

    const causalAndContra = repo.queryEdges({ edgeTypes: ['caused', 'contradicts'] });
    expect(causalAndContra).toHaveLength(2);
  });

  it('batch creation works with new edge types', () => {
    const inputs: CreateWeightedEdgeInput[] = [
      { sourceId: 's1', sourceType: 'hub', targetId: 't1', targetType: 'leaf', edgeType: 'refines' },
      { sourceId: 's2', sourceType: 'leaf', targetId: 't2', targetType: 'leaf', edgeType: 'precedes' },
      { sourceId: 's3', sourceType: 'hub', targetId: 't3', targetType: 'hub', edgeType: 'related' },
    ];

    const edges = repo.saveEdges(inputs);
    expect(edges).toHaveLength(3);
    expect(edges.map(e => e.edgeType).sort()).toEqual(['precedes', 'refines', 'related']);
  });
});
