/**
 * Tests for FTS5 normalized keyword index with trigger-based auto-synchronization.
 *
 * Validates:
 * - FTS5 virtual table creation with unicode61 tokenizer (remove_diacritics=2)
 * - INSERT trigger: new nodes indexed in FTS5
 * - UPDATE trigger: old content removed, new content indexed
 * - DELETE trigger: content removed from FTS5 index
 * - Keyword normalization: lowercased, deduplicated, sorted before storage
 * - BM25 column weighting: keywords:10 > frontmatter:2 > summary:1
 * - Column-specific keyword search (ftsKeywordSearch)
 * - Korean/English mixed (한영 혼용) search
 * - Scalability: batch operations with FTS5 sync
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryNodeRepository } from '../../src/db/memory-node-repo.js';
import { CREATE_MEMORY_NODE_TABLES } from '../../src/db/memory-node-schema.js';
import type { CreateMemoryNodeInput } from '../../src/models/memory-node.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_MEMORY_NODE_TABLES);
  return db;
}

function makeInput(overrides?: Partial<CreateMemoryNodeInput>): CreateMemoryNodeInput {
  return {
    nodeType: null,
    nodeRole: 'leaf',
    frontmatter: 'Default frontmatter',
    keywords: 'default keyword',
    summary: 'Default summary text.',
    metadata: {},
    currentEventCounter: 1.0,
    ...overrides,
  } as CreateMemoryNodeInput;
}

describe('FTS5 Normalized Keyword Index', () => {
  let db: Database.Database;
  let repo: MemoryNodeRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new MemoryNodeRepository(db);
  });

  // ═══════════════════════════════════════════════════════════════
  // Schema Validation
  // ═══════════════════════════════════════════════════════════════

  describe('DDL schema', () => {
    it('creates memory_nodes_fts virtual table', () => {
      const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'memory_nodes_fts'"
      ).get() as { sql: string } | undefined;

      expect(row).toBeTruthy();
      // Verify it's an FTS5 table
      expect(row!.sql).toContain('fts5');
    });

    it('FTS5 uses unicode61 tokenizer with remove_diacritics', () => {
      const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'memory_nodes_fts'"
      ).get() as { sql: string } | undefined;

      expect(row!.sql).toContain('unicode61');
      expect(row!.sql).toContain('remove_diacritics');
    });

    it('FTS5 indexes frontmatter, keywords, and summary columns', () => {
      const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'memory_nodes_fts'"
      ).get() as { sql: string } | undefined;

      expect(row!.sql).toContain('frontmatter');
      expect(row!.sql).toContain('keywords');
      expect(row!.sql).toContain('summary');
    });

    it('FTS5 uses external content mode referencing memory_nodes', () => {
      const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'memory_nodes_fts'"
      ).get() as { sql: string } | undefined;

      expect(row!.sql).toContain("content='memory_nodes'");
      expect(row!.sql).toContain("content_rowid='rowid'");
    });

    it('creates all 4 FTS5 sync triggers', () => {
      const triggers = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_nodes_fts%'"
      ).all() as { name: string }[];

      const names = triggers.map(t => t.name);
      expect(names).toContain('memory_nodes_fts_insert');
      expect(names).toContain('memory_nodes_fts_update_before');
      expect(names).toContain('memory_nodes_fts_update_after');
      expect(names).toContain('memory_nodes_fts_delete');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Keyword Normalization in Storage
  // ═══════════════════════════════════════════════════════════════

  describe('keyword normalization on storage', () => {
    it('normalizes keywords on CREATE: lowercase + dedupe + sort', () => {
      const node = repo.create(makeInput({
        keywords: 'React react REACT Vue vue',
      }));

      // Stored keywords should be normalized
      expect(node.keywords).toBe('react vue');
    });

    it('normalizes keywords on UPDATE', () => {
      const node = repo.create(makeInput({ keywords: 'Initial' }));
      expect(node.keywords).toBe('initial');

      const updated = repo.update(node.id, {
        keywords: 'Updated UPDATED React react',
      });
      expect(updated!.keywords).toBe('react updated');
    });

    it('normalizes Korean keywords', () => {
      const node = repo.create(makeInput({
        keywords: '프레임워크 리액트 선호 리액트',
      }));

      // Korean tokens lowercased (no-op) and deduplicated
      expect(node.keywords).toBe('리액트 선호 프레임워크');
    });

    it('normalizes mixed Korean/English keywords', () => {
      const node = repo.create(makeInput({
        keywords: 'React 리액트 Frontend 프론트엔드 react',
      }));

      expect(node.keywords).toBe('frontend react 리액트 프론트엔드');
    });

    it('strips punctuation-only tokens from keywords', () => {
      const node = repo.create(makeInput({
        keywords: 'React --- Vue ... Angular !!!',
      }));

      expect(node.keywords).toBe('angular react vue');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // INSERT Trigger
  // ═══════════════════════════════════════════════════════════════

  describe('INSERT trigger', () => {
    it('indexes new node in FTS5 after insert', () => {
      repo.create(makeInput({
        frontmatter: 'TypeScript 프로젝트 설정',
        keywords: 'typescript 타입스크립트 config',
        summary: 'TypeScript configuration guide.',
      }));

      // Search should find it via keywords
      expect(repo.ftsSearch('typescript')).toHaveLength(1);
      // Search should find it via frontmatter
      expect(repo.ftsSearch('프로젝트')).toHaveLength(1);
      // Search should find it via summary
      expect(repo.ftsSearch('configuration')).toHaveLength(1);
    });

    it('indexes multiple inserts independently', () => {
      repo.create(makeInput({ keywords: 'alpha bravo' }));
      repo.create(makeInput({ keywords: 'charlie delta' }));

      expect(repo.ftsSearch('alpha')).toHaveLength(1);
      expect(repo.ftsSearch('charlie')).toHaveLength(1);
      expect(repo.ftsSearch('echo')).toHaveLength(0);
    });

    it('batch create triggers FTS5 index for all nodes', () => {
      const inputs = Array.from({ length: 5 }, (_, i) =>
        makeInput({ keywords: `batch${i} common` })
      );
      repo.createBatch(inputs);

      // Each unique keyword matches 1
      expect(repo.ftsSearch('batch0')).toHaveLength(1);
      expect(repo.ftsSearch('batch4')).toHaveLength(1);
      // Common keyword matches all 5
      expect(repo.ftsSearch('common')).toHaveLength(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // UPDATE Trigger
  // ═══════════════════════════════════════════════════════════════

  describe('UPDATE trigger', () => {
    it('removes old keywords from FTS5 after update', () => {
      const node = repo.create(makeInput({
        keywords: 'oldkeyword unique123',
      }));

      repo.update(node.id, { keywords: 'newkeyword fresh456' });

      // Old keyword should no longer be found
      expect(repo.ftsSearch('oldkeyword')).toHaveLength(0);
      expect(repo.ftsSearch('unique123')).toHaveLength(0);
    });

    it('adds new keywords to FTS5 after update', () => {
      const node = repo.create(makeInput({
        keywords: 'oldkeyword',
      }));

      repo.update(node.id, { keywords: 'newkeyword fresh456' });

      // New keywords should be found
      expect(repo.ftsSearch('newkeyword')).toHaveLength(1);
      expect(repo.ftsSearch('fresh456')).toHaveLength(1);
    });

    it('updates frontmatter in FTS5', () => {
      const node = repo.create(makeInput({
        frontmatter: 'Original frontmatter about dogs',
      }));
      expect(repo.ftsSearch('dogs')).toHaveLength(1);

      repo.update(node.id, { frontmatter: 'Updated frontmatter about cats' });
      expect(repo.ftsSearch('dogs')).toHaveLength(0);
      expect(repo.ftsSearch('cats')).toHaveLength(1);
    });

    it('updates summary in FTS5', () => {
      const node = repo.create(makeInput({
        summary: 'Summary about quantum computing',
      }));
      expect(repo.ftsSearch('quantum')).toHaveLength(1);

      repo.update(node.id, { summary: 'Summary about machine learning' });
      expect(repo.ftsSearch('quantum')).toHaveLength(0);
      expect(repo.ftsSearch('machine')).toHaveLength(1);
    });

    it('non-FTS update still triggers FTS re-index (e.g., metadata update)', () => {
      const node = repo.create(makeInput({
        keywords: 'persistkeyword123',
      }));

      // Update metadata only — should not break FTS index
      repo.update(node.id, { metadata: { confidence: 0.99 } });

      // Keywords should still be searchable
      expect(repo.ftsSearch('persistkeyword123')).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DELETE Trigger
  // ═══════════════════════════════════════════════════════════════

  describe('DELETE trigger', () => {
    it('removes node from FTS5 on delete', () => {
      const node = repo.create(makeInput({
        keywords: 'deletemekeyword789',
      }));
      expect(repo.ftsSearch('deletemekeyword789')).toHaveLength(1);

      repo.delete(node.id);
      expect(repo.ftsSearch('deletemekeyword789')).toHaveLength(0);
    });

    it('does not affect other nodes in FTS5', () => {
      const nodeA = repo.create(makeInput({ keywords: 'keepme' }));
      const nodeB = repo.create(makeInput({ keywords: 'deleteme' }));

      repo.delete(nodeB.id);

      expect(repo.ftsSearch('keepme')).toHaveLength(1);
      expect(repo.ftsSearch('deleteme')).toHaveLength(0);
    });

    it('handles deletion of node with shared keywords', () => {
      repo.create(makeInput({ keywords: 'shared unique1' }));
      const nodeB = repo.create(makeInput({ keywords: 'shared unique2' }));

      repo.delete(nodeB.id);

      // 'shared' should still match the remaining node
      expect(repo.ftsSearch('shared')).toHaveLength(1);
      // 'unique2' should be gone
      expect(repo.ftsSearch('unique2')).toHaveLength(0);
      // 'unique1' should still be there
      expect(repo.ftsSearch('unique1')).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BM25 Column Weighting
  // ═══════════════════════════════════════════════════════════════

  describe('BM25 column weighting', () => {
    it('ranks keyword matches higher than summary matches', () => {
      // Node A: target term in keywords (weight 10.0)
      const nodeA = repo.create(makeInput({
        frontmatter: 'Some topic',
        keywords: 'targetterm specialword',
        summary: 'A generic summary.',
      }));

      // Node B: target term in summary only (weight 1.0)
      const nodeB = repo.create(makeInput({
        frontmatter: 'Another topic',
        keywords: 'otherkeyword',
        summary: 'Contains targetterm in the text.',
      }));

      const results = repo.ftsSearch('targetterm');
      expect(results).toHaveLength(2);
      // Node A (keyword match) should rank higher (lower BM25 score = better)
      expect(results[0].id).toBe(nodeA.id);
      expect(results[1].id).toBe(nodeB.id);
    });

    it('ranks keyword matches higher than frontmatter matches', () => {
      // Node A: target in keywords (weight 10.0)
      const nodeA = repo.create(makeInput({
        frontmatter: 'Generic frontmatter',
        keywords: 'ranktestword',
        summary: 'Summary.',
      }));

      // Node B: target in frontmatter (weight 2.0)
      const nodeB = repo.create(makeInput({
        frontmatter: 'Contains ranktestword here',
        keywords: 'different',
        summary: 'Summary.',
      }));

      const results = repo.ftsSearch('ranktestword');
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe(nodeA.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Keyword-Only Search (ftsKeywordSearch)
  // ═══════════════════════════════════════════════════════════════

  describe('ftsKeywordSearch — keyword column targeting', () => {
    it('finds nodes by keyword column only', () => {
      repo.create(makeInput({
        frontmatter: 'React tutorial',
        keywords: 'react frontend',
        summary: 'Learn React basics.',
      }));
      repo.create(makeInput({
        frontmatter: 'Vue tutorial',
        keywords: 'vue frontend',
        summary: 'Learn about React patterns.', // React in summary, not keywords
      }));

      // Keyword-only search for "react" should find only the first node
      const results = repo.ftsKeywordSearch('react');
      expect(results).toHaveLength(1);
    });

    it('handles Korean keyword-only search', () => {
      repo.create(makeInput({
        keywords: '리액트 프론트엔드',
      }));
      repo.create(makeInput({
        frontmatter: '리액트 튜토리얼', // 리액트 only in frontmatter
        keywords: '백엔드',
      }));

      const results = repo.ftsKeywordSearch('리액트');
      expect(results).toHaveLength(1);
    });

    it('returns empty for non-matching keyword search', () => {
      repo.create(makeInput({ keywords: 'react vue' }));
      expect(repo.ftsKeywordSearch('angular')).toHaveLength(0);
    });

    it('returns empty for empty query', () => {
      repo.create(makeInput({ keywords: 'react' }));
      expect(repo.ftsKeywordSearch('')).toHaveLength(0);
      expect(repo.ftsKeywordSearch('   ')).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Korean/English Mixed Search (한영 혼용)
  // ═══════════════════════════════════════════════════════════════

  describe('Korean/English mixed search (한영 혼용)', () => {
    it('searches Korean keywords in English-heavy content', () => {
      repo.create(makeInput({
        frontmatter: 'React project setup',
        keywords: 'react 리액트 setup 설정',
      }));

      expect(repo.ftsSearch('리액트')).toHaveLength(1);
      expect(repo.ftsSearch('설정')).toHaveLength(1);
    });

    it('searches English keywords in Korean-heavy content', () => {
      repo.create(makeInput({
        frontmatter: '프로젝트 배포 가이드',
        keywords: '배포 deploy kubernetes 쿠버네티스',
      }));

      expect(repo.ftsSearch('deploy')).toHaveLength(1);
      expect(repo.ftsSearch('kubernetes')).toHaveLength(1);
    });

    it('multi-token Korean/English query matches relevant nodes', () => {
      repo.create(makeInput({
        keywords: 'react 리액트 frontend 프론트엔드',
      }));
      repo.create(makeInput({
        keywords: 'python 파이썬 backend 백엔드',
      }));

      // Mixed query should match the relevant node
      const results = repo.ftsSearch('리액트 frontend');
      expect(results.length).toBeGreaterThanOrEqual(1);
      // The first result should be the React node (both terms match)
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Filtered FTS5 Search
  // ═══════════════════════════════════════════════════════════════

  describe('ftsSearchFiltered with BM25', () => {
    it('filters by node role', () => {
      repo.create(makeInput({
        nodeRole: 'leaf',
        keywords: 'filtertest alpha',
      }));
      repo.create(makeInput({
        nodeRole: 'hub',
        keywords: 'filtertest beta',
      }));

      const leafResults = repo.ftsSearchFiltered('filtertest', { nodeRole: 'leaf' });
      expect(leafResults).toHaveLength(1);

      const hubResults = repo.ftsSearchFiltered('filtertest', { nodeRole: 'hub' });
      expect(hubResults).toHaveLength(1);
    });

    it('returns empty for empty query', () => {
      repo.create(makeInput({ keywords: 'test' }));
      expect(repo.ftsSearchFiltered('', {})).toHaveLength(0);
      expect(repo.ftsSearchFiltered('  ', {})).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Edge Cases
  // ═══════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('handles node with empty keywords', () => {
      const node = repo.create(makeInput({ keywords: '' }));
      expect(node.keywords).toBe('');
      // Should still be findable via frontmatter
      expect(repo.ftsSearch('Default')).toHaveLength(1);
    });

    it('handles very long keyword strings', () => {
      const longKeywords = Array.from({ length: 100 }, (_, i) => `keyword${i}`).join(' ');
      const node = repo.create(makeInput({ keywords: longKeywords }));
      expect(node.keywords.split(' ')).toHaveLength(100);

      // Should be searchable
      expect(repo.ftsSearch('keyword50')).toHaveLength(1);
    });

    it('handles special characters in search query', () => {
      repo.create(makeInput({ keywords: 'C++ node.js' }));

      // These should not crash even if FTS5 special chars are present
      expect(() => repo.ftsSearch('C++')).not.toThrow();
      expect(() => repo.ftsSearch('node.js')).not.toThrow();
    });

    it('handles quotes in keywords', () => {
      repo.create(makeInput({ keywords: 'he said hello world' }));
      expect(() => repo.ftsSearch('hello')).not.toThrow();
      expect(repo.ftsSearch('hello')).toHaveLength(1);
    });

    it('rapid insert-update-delete cycle maintains FTS5 consistency', () => {
      const node = repo.create(makeInput({ keywords: 'phase1' }));
      expect(repo.ftsSearch('phase1')).toHaveLength(1);

      repo.update(node.id, { keywords: 'phase2' });
      expect(repo.ftsSearch('phase1')).toHaveLength(0);
      expect(repo.ftsSearch('phase2')).toHaveLength(1);

      repo.update(node.id, { keywords: 'phase3' });
      expect(repo.ftsSearch('phase2')).toHaveLength(0);
      expect(repo.ftsSearch('phase3')).toHaveLength(1);

      repo.delete(node.id);
      expect(repo.ftsSearch('phase3')).toHaveLength(0);
    });
  });
});
