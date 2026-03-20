/**
 * Tests for MemoryNodeRepository — validates the 4-layer progressive depth structure.
 *
 * L0: frontmatter + keywords + embedding (FTS5-indexed)
 * L1: JSON metadata (entities, category, confidence, SPO, etc.)
 * L2: summary text
 * L3: source_message_ids + conversation_id + source_turn_index
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryNodeRepository } from '../../src/db/memory-node-repo.js';
import { CREATE_MEMORY_NODE_TABLES } from '../../src/db/memory-node-schema.js';
import type { CreateMemoryNodeInput, MemoryNode } from '../../src/models/memory-node.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_MEMORY_NODE_TABLES);
  return db;
}

function makeFactInput(overrides?: Partial<CreateMemoryNodeInput>): CreateMemoryNodeInput {
  return {
    nodeType: 'semantic',
    nodeRole: 'leaf',
    frontmatter: '사용자는 React를 선호함',
    keywords: 'React 선호 프레임워크 preference',
    summary: '사용자가 프론트엔드 프레임워크로 React를 선호한다고 언급했다.',
    metadata: {
      entities: ['React'],
      category: 'preference',
      confidence: 0.9,
      subject: '사용자',
      predicate: '선호한다',
      object: 'React',
    },
    sourceMessageIds: ['msg-001', 'msg-002'],
    conversationId: 'conv-001',
    sourceTurnIndex: 3,
    currentEventCounter: 5.0,
    ...overrides,
  };
}

function makeHubInput(overrides?: Partial<CreateMemoryNodeInput>): CreateMemoryNodeInput {
  return {
    nodeType: 'semantic',
    nodeRole: 'hub',
    frontmatter: 'React',
    keywords: 'React 리액트 frontend UI library',
    summary: 'React is a JavaScript library for building user interfaces.',
    metadata: {
      aliases: ['리액트', 'ReactJS'],
      category: 'technology',
      relevance: 0.85,
      hubType: 'topic',
    },
    currentEventCounter: 10.0,
    ...overrides,
  };
}

describe('MemoryNodeRepository', () => {
  let db: Database.Database;
  let repo: MemoryNodeRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new MemoryNodeRepository(db);
  });

  // ═══════════════════════════════════════════════════════════════
  // Table Creation
  // ═══════════════════════════════════════════════════════════════

  describe('schema', () => {
    it('creates memory_nodes table with all required columns', () => {
      const cols = db.prepare("PRAGMA table_info('memory_nodes')").all() as { name: string; type: string }[];
      const colNames = cols.map(c => c.name);

      // Classification
      expect(colNames).toContain('id');
      expect(colNames).toContain('node_type');
      expect(colNames).toContain('node_role');

      // L0
      expect(colNames).toContain('frontmatter');
      expect(colNames).toContain('keywords');
      expect(colNames).toContain('embedding');
      expect(colNames).toContain('embedding_dim');

      // L1
      expect(colNames).toContain('metadata');

      // L2
      expect(colNames).toContain('summary');

      // L3
      expect(colNames).toContain('source_message_ids');
      expect(colNames).toContain('conversation_id');
      expect(colNames).toContain('source_turn_index');

      // Lifecycle
      expect(colNames).toContain('created_at_event');
      expect(colNames).toContain('last_activated_at_event');
      expect(colNames).toContain('activation_count');

      // Timestamps
      expect(colNames).toContain('created_at');
      expect(colNames).toContain('updated_at');
    });

    it('creates FTS5 virtual table', () => {
      // FTS5 tables appear in sqlite_master with type = 'table'
      const fts = db.prepare(
        "SELECT name FROM sqlite_master WHERE name = 'memory_nodes_fts'"
      ).get() as { name: string } | undefined;
      expect(fts).toBeTruthy();
      expect(fts!.name).toBe('memory_nodes_fts');
    });

    it('creates required indexes', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_nodes'"
      ).all() as { name: string }[];
      const indexNames = indexes.map(i => i.name);

      expect(indexNames).toContain('idx_memory_nodes_type');
      expect(indexNames).toContain('idx_memory_nodes_role');
      expect(indexNames).toContain('idx_memory_nodes_type_role');
      expect(indexNames).toContain('idx_memory_nodes_conversation');
      expect(indexNames).toContain('idx_memory_nodes_activation');
      expect(indexNames).toContain('idx_memory_nodes_hubs');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CRUD — Create
  // ═══════════════════════════════════════════════════════════════

  describe('create', () => {
    it('creates a fact node with all 4 layers', () => {
      const node = repo.create(makeFactInput());

      // Classification
      expect(node.id).toBeTruthy();
      expect(node.nodeType).toBe('semantic');
      expect(node.nodeRole).toBe('leaf');

      // L0
      expect(node.frontmatter).toBe('사용자는 React를 선호함');
      expect(node.keywords).toBe('preference react 선호 프레임워크');

      // L1
      expect(node.metadata.entities).toEqual(['React']);
      expect(node.metadata.category).toBe('preference');
      expect(node.metadata.confidence).toBe(0.9);
      expect(node.metadata.subject).toBe('사용자');
      expect(node.metadata.predicate).toBe('선호한다');
      expect(node.metadata.object).toBe('React');

      // L2
      expect(node.summary).toContain('React를 선호');

      // L3
      expect(node.sourceMessageIds).toEqual(['msg-001', 'msg-002']);
      expect(node.conversationId).toBe('conv-001');
      expect(node.sourceTurnIndex).toBe(3);

      // Lifecycle
      expect(node.createdAtEvent).toBe(5.0);
      expect(node.lastActivatedAtEvent).toBe(5.0);
      expect(node.activationCount).toBe(0);
    });

    it('creates a hub node', () => {
      const node = repo.create(makeHubInput());

      expect(node.nodeType).toBe('semantic');
      expect(node.nodeRole).toBe('hub');
      expect(node.frontmatter).toBe('React');
      expect(node.metadata.hubType).toBe('topic');
      expect(node.metadata.aliases).toEqual(['리액트', 'ReactJS']);
    });

    it('creates node with embedding', () => {
      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      const node = repo.create(makeFactInput({ embedding, embeddingDim: 4 }));

      expect(node.embedding).toBeInstanceOf(Float32Array);
      expect(node.embedding!.length).toBe(4);
      expect(node.embeddingDim).toBe(4);
      expect(node.embedding![0]).toBeCloseTo(0.1);
    });

    it('defaults to leaf role when not specified', () => {
      const input = makeFactInput();
      delete (input as any).nodeRole;
      const node = repo.create(input);
      expect(node.nodeRole).toBe('leaf');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CRUD — Read (Progressive Depth)
  // ═══════════════════════════════════════════════════════════════

  describe('read — progressive depth', () => {
    it('getById returns full node (all layers)', () => {
      const created = repo.create(makeFactInput());
      const node = repo.getById(created.id);

      expect(node).not.toBeNull();
      expect(node!.frontmatter).toBeTruthy(); // L0
      expect(node!.metadata).toBeTruthy();     // L1
      expect(node!.summary).toBeTruthy();      // L2
      expect(node!.sourceMessageIds.length).toBeGreaterThan(0); // L3
    });

    it('getRefsById returns L0 only', () => {
      const created = repo.create(makeFactInput());
      const refs = repo.getRefsById([created.id]);

      expect(refs).toHaveLength(1);
      expect(refs[0].id).toBe(created.id);
      expect(refs[0].frontmatter).toBeTruthy();
      expect(refs[0].keywords).toBeTruthy();
      // L0 ref should NOT include summary or metadata
      expect((refs[0] as any).summary).toBeUndefined();
      expect((refs[0] as any).metadata).toBeUndefined();
    });

    it('getL1ById returns L0+L1 (no summary)', () => {
      const created = repo.create(makeFactInput());
      const l1 = repo.getL1ById(created.id);

      expect(l1).not.toBeNull();
      expect(l1!.frontmatter).toBeTruthy();     // L0
      expect(l1!.metadata.category).toBe('preference'); // L1
      expect((l1 as any).summary).toBeUndefined();      // No L2
    });

    it('getL2ById returns L0+L1+L2', () => {
      const created = repo.create(makeFactInput());
      const l2 = repo.getL2ById(created.id);

      expect(l2).not.toBeNull();
      expect(l2!.frontmatter).toBeTruthy();  // L0
      expect(l2!.metadata).toBeTruthy();      // L1
      expect(l2!.summary).toBeTruthy();       // L2
    });

    it('getByIds preserves order', () => {
      const a = repo.create(makeFactInput({ frontmatter: 'AAA' }));
      const b = repo.create(makeFactInput({ frontmatter: 'BBB' }));
      const c = repo.create(makeFactInput({ frontmatter: 'CCC' }));

      const nodes = repo.getByIds([c.id, a.id, b.id]);
      expect(nodes.map(n => n.frontmatter)).toEqual(['CCC', 'AAA', 'BBB']);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CRUD — Update
  // ═══════════════════════════════════════════════════════════════

  describe('update', () => {
    it('updates frontmatter and keywords (L0)', () => {
      const node = repo.create(makeFactInput());
      const updated = repo.update(node.id, {
        frontmatter: '사용자는 Vue.js를 선호함',
        keywords: 'Vue.js 선호 프레임워크',
      });

      expect(updated!.frontmatter).toBe('사용자는 Vue.js를 선호함');
      expect(updated!.keywords).toBe('vue.js 선호 프레임워크');
    });

    it('merges metadata (L1)', () => {
      const node = repo.create(makeFactInput());
      const updated = repo.update(node.id, {
        metadata: { confidence: 0.95, salience: 0.8 },
      });

      // Original fields preserved
      expect(updated!.metadata.category).toBe('preference');
      expect(updated!.metadata.entities).toEqual(['React']);
      // Updated fields
      expect(updated!.metadata.confidence).toBe(0.95);
      expect(updated!.metadata.salience).toBe(0.8);
    });

    it('updates summary (L2)', () => {
      const node = repo.create(makeFactInput());
      const updated = repo.update(node.id, { summary: 'Updated summary' });
      expect(updated!.summary).toBe('Updated summary');
    });

    it('updates source message IDs (L3)', () => {
      const node = repo.create(makeFactInput());
      const updated = repo.update(node.id, {
        sourceMessageIds: ['msg-001', 'msg-002', 'msg-003'],
      });
      expect(updated!.sourceMessageIds).toEqual(['msg-001', 'msg-002', 'msg-003']);
    });

    it('promotes leaf to hub', () => {
      const node = repo.create(makeFactInput());
      expect(node.nodeRole).toBe('leaf');

      const promoted = repo.promoteToHub(node.id);
      expect(promoted!.nodeRole).toBe('hub');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Lifecycle — Event-based activation
  // ═══════════════════════════════════════════════════════════════

  describe('lifecycle', () => {
    it('records activation with event counter', () => {
      const node = repo.create(makeFactInput({ currentEventCounter: 10.0 }));
      expect(node.activationCount).toBe(0);
      expect(node.lastActivatedAtEvent).toBe(10.0);

      repo.recordActivation(node.id, 15.3);
      const updated = repo.getById(node.id)!;
      expect(updated.activationCount).toBe(1);
      expect(updated.lastActivatedAtEvent).toBe(15.3);
    });

    it('batch records activations', () => {
      const a = repo.create(makeFactInput({ frontmatter: 'A' }));
      const b = repo.create(makeFactInput({ frontmatter: 'B' }));

      repo.recordActivationBatch([a.id, b.id], 20.0);

      expect(repo.getById(a.id)!.activationCount).toBe(1);
      expect(repo.getById(b.id)!.activationCount).toBe(1);
      expect(repo.getById(a.id)!.lastActivatedAtEvent).toBe(20.0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // FTS5 Search
  // ═══════════════════════════════════════════════════════════════

  describe('FTS5 search', () => {
    it('searches Korean text', () => {
      repo.create(makeFactInput({ frontmatter: '사용자는 React를 선호함', keywords: 'React 선호' }));
      repo.create(makeFactInput({ frontmatter: '프로젝트 배포 완료', keywords: '배포 deploy' }));

      const results = repo.ftsSearch('선호');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBeTruthy();
    });

    it('searches English text', () => {
      repo.create(makeFactInput({ frontmatter: 'User prefers React', keywords: 'React preference frontend' }));
      repo.create(makeFactInput({ frontmatter: 'Deploy completed', keywords: 'deploy production' }));

      const results = repo.ftsSearch('React');
      expect(results).toHaveLength(1);
    });

    it('searches mixed Korean-English content (한영 혼용)', () => {
      repo.create(makeFactInput({
        frontmatter: 'TypeScript 프로젝트 설정',
        keywords: 'TypeScript 타입스크립트 설정 config',
      }));

      // Search by Korean
      const koreanResults = repo.ftsSearch('타입스크립트');
      expect(koreanResults).toHaveLength(1);

      // Search by English
      const englishResults = repo.ftsSearch('TypeScript');
      expect(englishResults).toHaveLength(1);
    });

    it('searches across frontmatter, keywords, and summary', () => {
      repo.create(makeFactInput({
        frontmatter: 'Fact about testing',
        keywords: 'vitest unit',
        summary: 'The project uses comprehensive integration tests.',
      }));

      // Match in frontmatter
      expect(repo.ftsSearch('testing')).toHaveLength(1);
      // Match in keywords
      expect(repo.ftsSearch('vitest')).toHaveLength(1);
      // Match in summary
      expect(repo.ftsSearch('integration')).toHaveLength(1);
    });

    it('ftsSearchFiltered filters by node type', () => {
      repo.create(makeFactInput({ nodeType: 'semantic', frontmatter: 'semantic about React' }));
      repo.create(makeHubInput({ nodeType: 'episodic', frontmatter: 'React episodic' }));

      const semantics = repo.ftsSearchFiltered('React', { nodeType: 'semantic' });
      expect(semantics).toHaveLength(1);

      const episodics = repo.ftsSearchFiltered('React', { nodeType: 'episodic' });
      expect(episodics).toHaveLength(1);
    });

    it('returns empty for empty query', () => {
      repo.create(makeFactInput());
      expect(repo.ftsSearch('')).toHaveLength(0);
      expect(repo.ftsSearch('  ')).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Vector Search
  // ═══════════════════════════════════════════════════════════════

  describe('vector search', () => {
    it('getAllEmbeddings returns nodes with embeddings', () => {
      const emb1 = new Float32Array([0.1, 0.2, 0.3]);
      const emb2 = new Float32Array([0.4, 0.5, 0.6]);
      repo.create(makeFactInput({ embedding: emb1, embeddingDim: 3 }));
      repo.create(makeFactInput({ embedding: emb2, embeddingDim: 3 }));
      repo.create(makeFactInput()); // no embedding

      const embeddings = repo.getAllEmbeddings();
      expect(embeddings).toHaveLength(2);
      expect(embeddings[0].embedding).toBeInstanceOf(Float32Array);
    });

    it('getEmbeddingsByIds returns map of embeddings', () => {
      const emb = new Float32Array([0.1, 0.2, 0.3]);
      const node = repo.create(makeFactInput({ embedding: emb, embeddingDim: 3 }));
      const noEmb = repo.create(makeFactInput());

      const map = repo.getEmbeddingsByIds([node.id, noEmb.id]);
      expect(map.size).toBe(1);
      expect(map.has(node.id)).toBe(true);
      expect(map.get(node.id)![0]).toBeCloseTo(0.1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Query
  // ═══════════════════════════════════════════════════════════════

  describe('query', () => {
    it('filters by nodeType', () => {
      repo.create(makeFactInput());
      repo.create(makeHubInput({ nodeType: 'episodic' }));

      const semantics = repo.query({ nodeType: 'semantic' });
      expect(semantics).toHaveLength(1);
      expect(semantics[0].nodeType).toBe('semantic');
    });

    it('filters by nodeRole', () => {
      repo.create(makeFactInput());
      repo.create(makeHubInput());

      const hubs = repo.query({ nodeRole: 'hub' });
      expect(hubs).toHaveLength(1);
      expect(hubs[0].nodeRole).toBe('hub');
    });

    it('filters by conversationId', () => {
      repo.create(makeFactInput({ conversationId: 'conv-A' }));
      repo.create(makeFactInput({ conversationId: 'conv-B' }));

      const results = repo.query({ conversationId: 'conv-A' });
      expect(results).toHaveLength(1);
    });

    it('limits results', () => {
      for (let i = 0; i < 10; i++) {
        repo.create(makeFactInput({ frontmatter: `Fact ${i}` }));
      }
      const results = repo.query({ limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('getHubs returns only hub nodes', () => {
      repo.create(makeFactInput());
      repo.create(makeHubInput());

      const hubs = repo.getHubs();
      expect(hubs).toHaveLength(1);
      expect(hubs[0].nodeRole).toBe('hub');
    });

    it('findHubByLabel is case-insensitive', () => {
      repo.create(makeHubInput({ frontmatter: 'React' }));

      expect(repo.findHubByLabel('react')).not.toBeNull();
      expect(repo.findHubByLabel('REACT')).not.toBeNull();
      expect(repo.findHubByLabel('React')).not.toBeNull();
    });

    it('count returns correct counts', () => {
      repo.create(makeFactInput());
      repo.create(makeFactInput());
      repo.create(makeHubInput({ nodeType: 'episodic' }));

      expect(repo.count()).toBe(3);
      expect(repo.count('semantic')).toBe(2);
      expect(repo.count('episodic')).toBe(1);
      expect(repo.count(undefined, 'hub')).toBe(1);
      expect(repo.count(undefined, 'leaf')).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Delete
  // ═══════════════════════════════════════════════════════════════

  describe('delete', () => {
    it('deletes a node', () => {
      const node = repo.create(makeFactInput());
      expect(repo.delete(node.id)).toBe(true);
      expect(repo.getById(node.id)).toBeNull();
    });

    it('returns false for non-existent node', () => {
      expect(repo.delete('non-existent')).toBe(false);
    });

    it('FTS index is cleaned up after delete', () => {
      const node = repo.create(makeFactInput({ keywords: 'uniqueDeleteTestKeyword' }));
      expect(repo.ftsSearch('uniqueDeleteTestKeyword')).toHaveLength(1);

      repo.delete(node.id);
      expect(repo.ftsSearch('uniqueDeleteTestKeyword')).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // FTS5 Trigger Sync
  // ═══════════════════════════════════════════════════════════════

  describe('FTS5 trigger sync', () => {
    it('FTS index updates when node is updated', () => {
      const node = repo.create(makeFactInput({ keywords: 'originalKeyword' }));
      expect(repo.ftsSearch('originalKeyword')).toHaveLength(1);

      repo.update(node.id, { keywords: 'updatedKeyword' });
      expect(repo.ftsSearch('originalKeyword')).toHaveLength(0);
      expect(repo.ftsSearch('updatedKeyword')).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Batch Operations
  // ═══════════════════════════════════════════════════════════════

  describe('batch operations', () => {
    it('createBatch creates multiple nodes in a transaction', () => {
      const inputs = Array.from({ length: 5 }, (_, i) =>
        makeFactInput({ frontmatter: `Batch fact ${i}` })
      );

      const nodes = repo.createBatch(inputs);
      expect(nodes).toHaveLength(5);
      expect(repo.count()).toBe(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Node Type Constraints
  // ═══════════════════════════════════════════════════════════════

  describe('constraints', () => {
    it('rejects invalid node_type', () => {
      expect(() => {
        repo.create(makeFactInput({ nodeType: 'invalid' as any }));
      }).toThrow();
    });

    it('rejects invalid node_role', () => {
      expect(() => {
        repo.create(makeFactInput({ nodeRole: 'invalid' as any }));
      }).toThrow();
    });

    it('allows all valid node types', () => {
      for (const nt of ['semantic', 'episodic', 'procedural', 'prospective', 'emotional'] as const) {
        const node = repo.create(makeFactInput({ nodeType: nt, frontmatter: `type-${nt}` }));
        expect(node.nodeType).toBe(nt);
      }
    });

    it('allows all valid node roles', () => {
      for (const nr of ['leaf', 'hub'] as const) {
        const node = repo.create(makeFactInput({ nodeRole: nr, frontmatter: `role-${nr}` }));
        expect(node.nodeRole).toBe(nr);
      }
    });
  });
});
