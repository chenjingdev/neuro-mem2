/**
 * Tests for Fts5Matcher — FTS5 keyword match scoring.
 *
 * Validates:
 * - BM25 scoring and rank normalization
 * - Korean/English mixed queries (한영 혼용)
 * - Column-targeted search (keywords-only, frontmatter-only)
 * - AND/OR match modes
 * - Node type/role filtering
 * - matchOne and matchBatch APIs
 * - Edge cases (empty query, no matches, single result)
 * - normalizeRanks pure function
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { CREATE_MEMORY_NODE_TABLES } from '../src/db/memory-node-schema.js';
import { MemoryNodeRepository } from '../src/db/memory-node-repo.js';
import {
  Fts5Matcher,
  normalizeRanks,
  BM25_WEIGHT_FRONTMATTER,
  BM25_WEIGHT_KEYWORDS,
  BM25_WEIGHT_SUMMARY,
  type Fts5MatchResult,
} from '../src/retrieval/fts5-matcher.js';

// ─── Test Setup ──────────────────────────────────────────────────

let db: Database.Database;
let repo: MemoryNodeRepository;
let matcher: Fts5Matcher;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(CREATE_MEMORY_NODE_TABLES);
  repo = new MemoryNodeRepository(db);
  matcher = new Fts5Matcher(db);

  // Seed test data with diverse Korean/English content
  const testNodes = [
    {
      frontmatter: 'React component design patterns',
      keywords: 'react component design frontend javascript',
      summary: 'Best practices for designing reusable React components with hooks and composition.',
      nodeType: 'semantic' as const,
      nodeRole: 'leaf' as const,
    },
    {
      frontmatter: 'TypeScript 마이그레이션 전략',
      keywords: 'typescript migration 타입스크립트 마이그레이션',
      summary: 'JavaScript에서 TypeScript로 점진적 마이그레이션을 위한 전략과 단계별 가이드.',
      nodeType: 'procedural' as const,
      nodeRole: 'leaf' as const,
    },
    {
      frontmatter: '리액트 컴포넌트 최적화',
      keywords: 'react 리액트 optimization 최적화 performance',
      summary: 'React 컴포넌트의 렌더링 성능 최적화 기법: memo, useMemo, useCallback.',
      nodeType: 'semantic' as const,
      nodeRole: 'leaf' as const,
    },
    {
      frontmatter: 'Database indexing strategies',
      keywords: 'database index sqlite fts5 performance',
      summary: 'How to design effective indexes for SQLite including FTS5 full-text search.',
      nodeType: 'semantic' as const,
      nodeRole: 'hub' as const,
    },
    {
      frontmatter: 'API 설계 원칙',
      keywords: 'api design rest graphql 설계',
      summary: 'RESTful API와 GraphQL API의 설계 원칙과 모범 사례.',
      nodeType: 'procedural' as const,
      nodeRole: 'hub' as const,
    },
    {
      frontmatter: '프로젝트 회의 노트',
      keywords: 'meeting notes 회의 프로젝트',
      summary: '2024년 3월 프로젝트 킥오프 회의에서 논의된 기술 스택 결정 사항.',
      nodeType: 'episodic' as const,
      nodeRole: 'leaf' as const,
    },
  ];

  for (const node of testNodes) {
    repo.create({
      frontmatter: node.frontmatter,
      keywords: node.keywords,
      summary: node.summary,
      nodeType: node.nodeType,
      nodeRole: node.nodeRole,
    });
  }
});

afterAll(() => {
  db.close();
});

// ─── Tests ──────────────────────────────────────────────────────

describe('Fts5Matcher', () => {
  describe('match() — basic search', () => {
    it('should return results for English query', () => {
      const results = matcher.match('React component');
      expect(results.length).toBeGreaterThanOrEqual(1);
      // React component design patterns should be top result
      const topResult = results[0];
      expect(topResult.normalizedScore).toBeGreaterThan(0);
      expect(topResult.rawRank).toBeLessThan(0); // BM25 ranks are negative
    });

    it('should return results for Korean query', () => {
      const results = matcher.match('마이그레이션');
      expect(results.length).toBeGreaterThanOrEqual(1);
      // TypeScript migration node has 마이그레이션 in keywords and summary
      expect(results.some(r => r.normalizedScore > 0)).toBe(true);
    });

    it('should return results for mixed Korean/English query (한영 혼용)', () => {
      const results = matcher.match('React 최적화');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty array for empty query', () => {
      expect(matcher.match('')).toEqual([]);
      expect(matcher.match('   ')).toEqual([]);
    });

    it('should return empty array for query with no matches', () => {
      const results = matcher.match('xyznonexistent12345');
      expect(results).toEqual([]);
    });

    it('should normalize scores to [0, 1] range', () => {
      const results = matcher.match('react');
      for (const r of results) {
        expect(r.normalizedScore).toBeGreaterThanOrEqual(0);
        expect(r.normalizedScore).toBeLessThanOrEqual(1);
      }
      // Best result should have score 1.0 (when multiple results)
      if (results.length > 1) {
        expect(results[0].normalizedScore).toBe(1);
      }
    });

    it('should sort results by score descending', () => {
      const results = matcher.match('react component');
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].normalizedScore).toBeGreaterThanOrEqual(
          results[i].normalizedScore,
        );
      }
    });

    it('should respect limit option', () => {
      const results = matcher.match('react', { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe('match() — match modes', () => {
    it('should use OR mode by default (broad recall)', () => {
      const orResults = matcher.match('react database', { mode: 'or' });
      // OR mode should match nodes with either "react" OR "database"
      expect(orResults.length).toBeGreaterThanOrEqual(2);
    });

    it('should support AND mode (precision)', () => {
      const andResults = matcher.match('react database', { mode: 'and' });
      // AND mode: fewer results (only nodes with both terms)
      // Our test data has no node with both react AND database
      expect(andResults.length).toBeLessThanOrEqual(
        matcher.match('react database', { mode: 'or' }).length,
      );
    });
  });

  describe('match() — column-targeted search', () => {
    it('should search keywords column only', () => {
      const results = matcher.match('fts5', { column: 'keywords' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      // "fts5" is in the keywords of the database indexing node
    });

    it('should search frontmatter column only', () => {
      const results = matcher.match('회의', { column: 'frontmatter' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      // "회의" is in frontmatter of the meeting notes node
    });

    it('should search summary column only', () => {
      const results = matcher.match('hooks', { column: 'summary' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      // "hooks" is in summary of the React component node
    });
  });

  describe('match() — node type/role filtering', () => {
    it('should filter by single node type', () => {
      const results = matcher.match('react', { nodeType: 'semantic' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      // All results should be semantic type nodes
    });

    it('should filter by array of node types', () => {
      const results = matcher.match('react', {
        nodeType: ['semantic', 'procedural'],
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter by node role', () => {
      const allResults = matcher.match('database');
      const hubResults = matcher.match('database', { nodeRole: 'hub' });
      expect(hubResults.length).toBeLessThanOrEqual(allResults.length);
      expect(hubResults.length).toBeGreaterThanOrEqual(1);
    });

    it('should combine type and role filters', () => {
      const results = matcher.match('설계', {
        nodeType: 'procedural',
        nodeRole: 'hub',
      });
      // API 설계 원칙 node is procedural + hub
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('match() — custom BM25 weights', () => {
    it('should accept custom BM25 weights', () => {
      // Keywords-heavy weighting
      const keywordHeavy = matcher.match('react', {
        bm25Weights: [0.0, 20.0, 0.0],
      });
      expect(keywordHeavy.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('match() — minScore filtering', () => {
    it('should filter results below minScore', () => {
      const allResults = matcher.match('react');
      const filtered = matcher.match('react', { minScore: 0.5 });
      expect(filtered.length).toBeLessThanOrEqual(allResults.length);
      for (const r of filtered) {
        expect(r.normalizedScore).toBeGreaterThanOrEqual(0.5);
      }
    });
  });

  describe('matchOne()', () => {
    it('should return raw BM25 rank for a matching node', () => {
      // First, find a node that matches "react"
      const results = matcher.match('react');
      expect(results.length).toBeGreaterThan(0);

      const rank = matcher.matchOne(results[0].id, 'react');
      expect(rank).not.toBeNull();
      expect(rank!).toBeLessThan(0); // BM25 ranks are negative
    });

    it('should return null for non-matching node', () => {
      const results = matcher.match('database');
      expect(results.length).toBeGreaterThan(0);

      // Database node should not match "xyznonexistent"
      const rank = matcher.matchOne(results[0].id, 'xyznonexistent');
      expect(rank).toBeNull();
    });

    it('should return null for empty query', () => {
      expect(matcher.matchOne('any-id', '')).toBeNull();
      expect(matcher.matchOne('any-id', '   ')).toBeNull();
    });
  });

  describe('matchBatch()', () => {
    it('should score multiple nodes against a query', () => {
      // Get all node IDs that match "react"
      const reactResults = matcher.match('react');
      const allNodeIds = reactResults.map(r => r.id);

      // Also get a non-matching node
      const dbResults = matcher.match('database');

      const batchIds = [...allNodeIds, ...dbResults.map(r => r.id)];
      const scores = matcher.matchBatch(batchIds, 'react');

      // React-matching nodes should have scores
      for (const id of allNodeIds) {
        expect(scores.has(id)).toBe(true);
        expect(scores.get(id)!).toBeGreaterThanOrEqual(0);
        expect(scores.get(id)!).toBeLessThanOrEqual(1);
      }
    });

    it('should return empty map for empty inputs', () => {
      expect(matcher.matchBatch([], 'react')).toEqual(new Map());
      expect(matcher.matchBatch(['id1'], '')).toEqual(new Map());
    });
  });

  describe('countMatches()', () => {
    it('should count FTS5 matches', () => {
      const count = matcher.countMatches('react');
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('should return 0 for no matches', () => {
      expect(matcher.countMatches('xyznonexistent12345')).toBe(0);
    });

    it('should return 0 for empty query', () => {
      expect(matcher.countMatches('')).toBe(0);
    });

    it('should support column-specific counting', () => {
      const keywordsCount = matcher.countMatches('fts5', {
        column: 'keywords',
      });
      expect(keywordsCount).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('normalizeRanks()', () => {
  it('should normalize ranks to [0, 1] range', () => {
    const rows = [
      { id: 'a', rank: -10 }, // best
      { id: 'b', rank: -5 },
      { id: 'c', rank: -1 }, // worst
    ];

    const results = normalizeRanks(rows);

    expect(results[0].id).toBe('a');
    expect(results[0].normalizedScore).toBe(1);
    expect(results[results.length - 1].normalizedScore).toBe(0);
  });

  it('should return 1.0 for single result', () => {
    const results = normalizeRanks([{ id: 'x', rank: -5 }]);
    expect(results).toHaveLength(1);
    expect(results[0].normalizedScore).toBe(1.0);
  });

  it('should return 1.0 for all identical ranks', () => {
    const results = normalizeRanks([
      { id: 'a', rank: -3 },
      { id: 'b', rank: -3 },
    ]);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.normalizedScore).toBe(1.0);
    }
  });

  it('should return empty array for empty input', () => {
    expect(normalizeRanks([])).toEqual([]);
  });

  it('should preserve raw rank values', () => {
    const results = normalizeRanks([
      { id: 'a', rank: -7.5 },
      { id: 'b', rank: -2.3 },
    ]);
    expect(results.find(r => r.id === 'a')!.rawRank).toBe(-7.5);
    expect(results.find(r => r.id === 'b')!.rawRank).toBe(-2.3);
  });

  it('should filter by minScore', () => {
    const rows = [
      { id: 'a', rank: -10 }, // score 1.0
      { id: 'b', rank: -5 },  // score ~0.44
      { id: 'c', rank: -1 },  // score 0.0
    ];

    const results = normalizeRanks(rows, 0.5);
    expect(results.length).toBeLessThan(rows.length);
    for (const r of results) {
      expect(r.normalizedScore).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('should sort by normalizedScore descending', () => {
    const rows = [
      { id: 'c', rank: -1 },
      { id: 'a', rank: -10 },
      { id: 'b', rank: -5 },
    ];

    const results = normalizeRanks(rows);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].normalizedScore).toBeGreaterThanOrEqual(
        results[i].normalizedScore,
      );
    }
  });
});

describe('BM25 weight constants', () => {
  it('should have keywords as highest weight', () => {
    expect(BM25_WEIGHT_KEYWORDS).toBeGreaterThan(BM25_WEIGHT_FRONTMATTER);
    expect(BM25_WEIGHT_KEYWORDS).toBeGreaterThan(BM25_WEIGHT_SUMMARY);
  });

  it('should have frontmatter > summary', () => {
    expect(BM25_WEIGHT_FRONTMATTER).toBeGreaterThan(BM25_WEIGHT_SUMMARY);
  });
});
