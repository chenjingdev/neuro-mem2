/**
 * Tests for HubCandidateExtractor — entity extraction → hub candidate pipeline.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  normalizeEntityLabel,
  looksLikeNamedEntity,
  detectHubType,
  computeNewHubConfidence,
  HubCandidateExtractor,
} from '../src/extraction/hub-candidate-extractor.js';
import type { ExtractedMemoryNode } from '../src/models/memory-node.js';
import { CREATE_MEMORY_NODE_TABLES } from '../src/db/memory-node-schema.js';

// ─── Pure Function Tests ──────────────────────────────────────────

describe('normalizeEntityLabel', () => {
  it('should lowercase and trim', () => {
    expect(normalizeEntityLabel('  React  ')).toBe('react');
    expect(normalizeEntityLabel('TypeScript')).toBe('typescript');
  });

  it('should collapse internal whitespace', () => {
    expect(normalizeEntityLabel('machine   learning')).toBe('machine learning');
  });

  it('should handle Korean text', () => {
    expect(normalizeEntityLabel('  머신러닝  ')).toBe('머신러닝');
    expect(normalizeEntityLabel('자연어   처리')).toBe('자연어 처리');
  });

  it('should return empty string for invalid input', () => {
    expect(normalizeEntityLabel('')).toBe('');
    expect(normalizeEntityLabel('   ')).toBe('');
  });

  it('should handle mixed Korean/English', () => {
    expect(normalizeEntityLabel('React 컴포넌트')).toBe('react 컴포넌트');
  });
});

describe('looksLikeNamedEntity', () => {
  it('should detect capitalized English words', () => {
    expect(looksLikeNamedEntity('React')).toBe(true);
    expect(looksLikeNamedEntity('TypeScript')).toBe(true);
    expect(looksLikeNamedEntity('PostgreSQL')).toBe(true);
  });

  it('should detect technical terms with special chars', () => {
    expect(looksLikeNamedEntity('Node.js')).toBe(true);
    expect(looksLikeNamedEntity('C++')).toBe(true);
    expect(looksLikeNamedEntity('C#')).toBe(true);
  });

  it('should detect multi-word phrases', () => {
    expect(looksLikeNamedEntity('machine learning')).toBe(true);
    expect(looksLikeNamedEntity('natural language processing')).toBe(true);
  });

  it('should detect Korean named entities (2+ syllables)', () => {
    expect(looksLikeNamedEntity('머신러닝')).toBe(true);
    expect(looksLikeNamedEntity('타입스크립트')).toBe(true);
    expect(looksLikeNamedEntity('리액트')).toBe(true);
  });

  it('should reject single Korean character', () => {
    expect(looksLikeNamedEntity('가')).toBe(false);
  });

  it('should reject short lowercase words', () => {
    expect(looksLikeNamedEntity('a')).toBe(false);
    expect(looksLikeNamedEntity('if')).toBe(false);
    expect(looksLikeNamedEntity('the')).toBe(false);
  });

  it('should reject empty/whitespace strings', () => {
    expect(looksLikeNamedEntity('')).toBe(false);
    expect(looksLikeNamedEntity(' ')).toBe(false);
  });
});

describe('detectHubType', () => {
  it('should detect temporal entities', () => {
    expect(detectHubType('2024 Q1 Review', false)).toBe('temporal');
    expect(detectHubType('January release', false)).toBe('temporal');
    expect(detectHubType('2025년 계획', false)).toBe('temporal');
    expect(detectHubType('3분기 목표', false)).toBe('temporal');
  });

  it('should detect named entities from relatedEntities + capitalized', () => {
    expect(detectHubType('React', true)).toBe('entity');
    expect(detectHubType('John Smith', true)).toBe('entity');
  });

  it('should detect technical tool names as entities', () => {
    expect(detectHubType('TypeScript', false)).toBe('entity');
    expect(detectHubType('PostgreSQL', false)).toBe('entity');
  });

  it('should detect abstract topics', () => {
    expect(detectHubType('machine learning', false)).toBe('topic');
    expect(detectHubType('data structures', false)).toBe('topic');
  });

  it('should use relatedEntities flag as tiebreaker', () => {
    expect(detectHubType('api', true)).toBe('entity');
    expect(detectHubType('api', false)).toBe('topic');
  });
});

describe('computeNewHubConfidence', () => {
  it('should give base confidence of 0.5', () => {
    const entity = {
      normalizedLabel: 'test',
      originalLabels: ['test'],
      sourceNodeIndices: new Set([0]),
      mentionCount: 1,
      fromRelatedEntities: false,
    };
    expect(computeNewHubConfidence(entity)).toBe(0.5);
  });

  it('should boost for relatedEntities source', () => {
    const entity = {
      normalizedLabel: 'test',
      originalLabels: ['test'],
      sourceNodeIndices: new Set([0]),
      mentionCount: 1,
      fromRelatedEntities: true,
    };
    expect(computeNewHubConfidence(entity)).toBe(0.7);
  });

  it('should boost for multi-node mentions', () => {
    const entity = {
      normalizedLabel: 'test',
      originalLabels: ['test'],
      sourceNodeIndices: new Set([0, 1, 2]),
      mentionCount: 3,
      fromRelatedEntities: false,
    };
    // base 0.5 + multi-node(>=3) 0.15 + mention(>=3) 0.1 = 0.75
    expect(computeNewHubConfidence(entity)).toBe(0.75);
  });

  it('should cap at 1.0', () => {
    const entity = {
      normalizedLabel: 'test',
      originalLabels: ['test'],
      sourceNodeIndices: new Set([0, 1, 2, 3, 4]),
      mentionCount: 10,
      fromRelatedEntities: true,
    };
    expect(computeNewHubConfidence(entity)).toBeLessThanOrEqual(1.0);
  });
});

// ─── Integration Tests (with in-memory SQLite) ───────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(CREATE_MEMORY_NODE_TABLES);
  return db;
}

function makeExtractedNode(overrides: Partial<ExtractedMemoryNode> = {}): ExtractedMemoryNode {
  return {
    nodeType: 'semantic',
    frontmatter: 'Test node',
    keywords: 'test keyword',
    searchKeywords: ['test', 'keyword'],
    relatedEntities: [],
    summary: 'A test node for testing',
    metadata: {},
    ...overrides,
  };
}

describe('HubCandidateExtractor', () => {
  describe('collectEntities via extractSync', () => {
    it('should extract entities from relatedEntities', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db);

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: ['React', 'TypeScript'],
        }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      expect(result.stats.uniqueEntitiesFound).toBe(2);
      expect(result.candidates.length).toBe(2);
      expect(result.candidates.map(c => c.label).sort()).toEqual(['React', 'TypeScript']);
    });

    it('should deduplicate entities across nodes (case-insensitive)', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db);

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: ['React', 'TypeScript'],
        }),
        makeExtractedNode({
          relatedEntities: ['react', 'Python'],
        }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      // 'React' and 'react' should merge → 3 unique entities
      expect(result.stats.uniqueEntitiesFound).toBe(3);
    });

    it('should include keyword-derived entities when enabled', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db, {
        includeKeywordEntities: true,
      });

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: [],
          searchKeywords: ['React', 'hooks', 'Component'],
        }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      // 'React' and 'Component' look like named entities; 'hooks' does not
      const labels = result.candidates.map(c => c.label.toLowerCase());
      expect(labels).toContain('react');
      expect(labels).toContain('component');
    });

    it('should not include keyword entities when disabled', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db, {
        includeKeywordEntities: false,
      });

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: [],
          searchKeywords: ['React', 'hooks', 'Component'],
        }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      expect(result.candidates.length).toBe(0);
    });

    it('should filter out too-short entities', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db, {
        minEntityLength: 3,
      });

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: ['AI', 'ab', 'Machine Learning'],
        }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      expect(result.stats.entitiesFiltered).toBe(2); // 'ai' and 'ab' filtered
      expect(result.candidates.length).toBe(1);
      expect(result.candidates[0]!.label).toBe('Machine Learning');
    });

    it('should handle Korean entities properly', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db);

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: ['리액트', '타입스크립트', '자연어 처리'],
        }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      expect(result.candidates.length).toBe(3);
    });

    it('should merge metadata.entities with relatedEntities', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db);

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: ['React'],
          metadata: { entities: ['React', 'Vite'] },
        }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      // 'React' deduplicated, 'Vite' from metadata
      expect(result.stats.uniqueEntitiesFound).toBe(2);
    });

    it('should track source node indices', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db);

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({ relatedEntities: ['React'] }),
        makeExtractedNode({ relatedEntities: ['React', 'Vue'] }),
        makeExtractedNode({ relatedEntities: ['Angular'] }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      const reactCandidate = result.candidates.find(
        c => c.label.toLowerCase() === 'react'
      );
      expect(reactCandidate).toBeDefined();
      expect(reactCandidate!.sourceNodeIndices).toEqual([0, 1]);
      expect(reactCandidate!.mentionCount).toBe(2);
    });

    it('should respect maxCandidatesTotal limit', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db, {
        maxCandidatesTotal: 2,
      });

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: ['Alpha', 'Beta', 'Gamma', 'Delta'],
        }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      expect(result.candidates.length).toBeLessThanOrEqual(2);
    });

    it('should sort by confidence descending', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db);

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({ relatedEntities: ['React'] }),
        makeExtractedNode({ relatedEntities: ['React'] }),
        makeExtractedNode({ relatedEntities: ['React', 'Vue'] }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      // React appears in all 3 nodes → higher confidence than Vue
      const labels = result.candidates.map(c => c.label.toLowerCase());
      expect(labels[0]).toBe('react');
    });

    it('should handle empty nodes array', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db);

      const result = extractor.extractSync([], new Map());
      expect(result.candidates.length).toBe(0);
      expect(result.stats.uniqueEntitiesFound).toBe(0);
    });

    it('should handle nodes with no entities', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db, {
        includeKeywordEntities: false,
      });

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: [],
          metadata: {},
        }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      expect(result.candidates.length).toBe(0);
    });

    it('should classify all candidates as new when no hubs exist in DB', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db);

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: ['React', 'TypeScript'],
        }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      expect(result.existingHubs.length).toBe(0);
      expect(result.newHubProposals.length).toBe(2);
      for (const c of result.candidates) {
        expect(c.kind).toBe('new');
      }
    });

    it('should assign hubType based on heuristics', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db);

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: ['React', '2024 Q1 Review', 'machine learning'],
        }),
      ];

      const result = extractor.extractSync(nodes, new Map());
      const hubTypes = new Map(
        result.candidates.map(c => [c.label.toLowerCase(), c.hubType])
      );

      expect(hubTypes.get('react')).toBe('entity');
      expect(hubTypes.get('2024 q1 review')).toBe('temporal');
      expect(hubTypes.get('machine learning')).toBe('topic');
    });
  });

  describe('existing hub matching', () => {
    it('should match entities to existing hubs via FTS5+cosine when embeddings match', () => {
      const db = createTestDb();

      // Create a hub in the DB
      const hubId = 'hub-react-001';
      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      db.prepare(`
        INSERT INTO memory_nodes (id, node_type, node_role, frontmatter, keywords, summary, metadata, embedding, embedding_dim, source_message_ids, created_at_event, last_activated_at_event, activation_count, created_at, updated_at)
        VALUES (?, 'semantic', 'hub', 'React', 'react javascript ui library', 'React is a JavaScript library', '{}', ?, 4, '[]', 0, 0, 0, datetime('now'), datetime('now'))
      `).run(hubId, Buffer.from(embedding.buffer));

      const extractor = new HubCandidateExtractor(db, {
        similarityThreshold: 0.8,
      });

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: ['React'],
        }),
      ];

      // Use a similar embedding for the entity
      const entityEmbeddings = new Map<string, number[]>();
      entityEmbeddings.set('react', [0.1, 0.2, 0.3, 0.4]); // identical → cosine = 1.0

      const result = extractor.extractSync(nodes, entityEmbeddings);

      expect(result.existingHubs.length).toBe(1);
      expect(result.existingHubs[0]!.kind).toBe('existing');
      expect(result.existingHubs[0]!.existingMatch!.hubId).toBe(hubId);
      expect(result.existingHubs[0]!.existingMatch!.cosineSimilarity).toBeCloseTo(1.0, 2);
    });
  });

  describe('stats', () => {
    it('should report accurate stats', () => {
      const db = createTestDb();
      const extractor = new HubCandidateExtractor(db, {
        minEntityLength: 3,
      });

      const nodes: ExtractedMemoryNode[] = [
        makeExtractedNode({
          relatedEntities: ['React', 'AI', 'TypeScript'],
        }),
        makeExtractedNode({
          relatedEntities: ['React', 'Vue'],
        }),
      ];

      const result = extractor.extractSync(nodes, new Map());

      expect(result.stats.uniqueEntitiesFound).toBe(4); // React, AI, TypeScript, Vue
      expect(result.stats.entitiesFiltered).toBe(1); // 'ai' (2 chars < 3 min)
      expect(result.stats.newHubProposals).toBe(3); // React, TypeScript, Vue
      expect(result.stats.existingHubMatches).toBe(0);
      expect(result.stats.matchingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
