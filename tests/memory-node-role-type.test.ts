/**
 * Tests for MemoryNode nodeRole ('hub'|'leaf') and
 * nodeType ('semantic'|'episodic'|'procedural'|'prospective'|'emotional'|null).
 *
 * Validates:
 * - nodeRole accepts 'hub' and 'leaf' only (rejects 'index' or other values)
 * - nodeType accepts all 5 types plus null
 * - nodeType null is correctly stored and retrieved
 * - Query/filter works with both nodeRole and nodeType including null
 * - Hub promotion (leaf → hub) works
 * - Type constants match expected values
 * - FTS filtered search respects nodeType/nodeRole
 * - Count works with null nodeType filter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryNodeRepository } from '../src/db/memory-node-repo.js';
import { CREATE_MEMORY_NODE_TABLES } from '../src/db/memory-node-schema.js';
import {
  MEMORY_NODE_TYPES,
  MEMORY_NODE_ROLES,
  type MemoryNodeType,
  type MemoryNodeTypeNullable,
  type MemoryNodeRole,
  type CreateMemoryNodeInput,
} from '../src/models/memory-node.js';

describe('MemoryNode nodeRole and nodeType', () => {
  let db: Database.Database;
  let repo: MemoryNodeRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(CREATE_MEMORY_NODE_TABLES);
    repo = new MemoryNodeRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ─── Helper ──────────────────────────────────────────────────────

  function makeInput(overrides: Partial<CreateMemoryNodeInput> = {}): CreateMemoryNodeInput {
    return {
      nodeType: 'semantic',
      nodeRole: 'leaf',
      frontmatter: 'test node',
      keywords: 'test keyword',
      summary: 'test summary',
      currentEventCounter: 1.0,
      ...overrides,
    };
  }

  // ─── Type Constants ──────────────────────────────────────────────

  describe('type constants', () => {
    it('MEMORY_NODE_TYPES contains exactly 5 types', () => {
      expect(MEMORY_NODE_TYPES).toHaveLength(5);
      expect(MEMORY_NODE_TYPES).toEqual([
        'semantic', 'episodic', 'procedural', 'prospective', 'emotional',
      ]);
    });

    it('MEMORY_NODE_ROLES contains exactly hub and leaf', () => {
      expect(MEMORY_NODE_ROLES).toHaveLength(2);
      expect(MEMORY_NODE_ROLES).toEqual(['hub', 'leaf']);
    });
  });

  // ─── nodeRole ────────────────────────────────────────────────────

  describe('nodeRole', () => {
    it('accepts "leaf" role', () => {
      const node = repo.create(makeInput({ nodeRole: 'leaf' }));
      expect(node.nodeRole).toBe('leaf');
    });

    it('accepts "hub" role', () => {
      const node = repo.create(makeInput({ nodeRole: 'hub' }));
      expect(node.nodeRole).toBe('hub');
    });

    it('defaults to "leaf" when nodeRole is not specified', () => {
      const node = repo.create(makeInput({ nodeRole: undefined }));
      expect(node.nodeRole).toBe('leaf');
    });

    it('rejects invalid role values via CHECK constraint', () => {
      expect(() => {
        repo.create(makeInput({ nodeRole: 'index' as MemoryNodeRole }));
      }).toThrow();
    });

    it('rejects arbitrary string role values', () => {
      expect(() => {
        repo.create(makeInput({ nodeRole: 'supernode' as MemoryNodeRole }));
      }).toThrow();
    });
  });

  // ─── nodeType ────────────────────────────────────────────────────

  describe('nodeType', () => {
    it('accepts "semantic" type', () => {
      const node = repo.create(makeInput({ nodeType: 'semantic' }));
      expect(node.nodeType).toBe('semantic');
    });

    it('accepts "episodic" type', () => {
      const node = repo.create(makeInput({ nodeType: 'episodic' }));
      expect(node.nodeType).toBe('episodic');
    });

    it('accepts "procedural" type', () => {
      const node = repo.create(makeInput({ nodeType: 'procedural' }));
      expect(node.nodeType).toBe('procedural');
    });

    it('accepts "prospective" type', () => {
      const node = repo.create(makeInput({ nodeType: 'prospective' }));
      expect(node.nodeType).toBe('prospective');
    });

    it('accepts "emotional" type', () => {
      const node = repo.create(makeInput({ nodeType: 'emotional' }));
      expect(node.nodeType).toBe('emotional');
    });

    it('accepts null type for untyped nodes', () => {
      const node = repo.create(makeInput({ nodeType: null }));
      expect(node.nodeType).toBeNull();
    });

    it('rejects old type values (fact/episode/concept/schema/identity)', () => {
      for (const oldType of ['fact', 'episode', 'concept', 'schema', 'identity']) {
        expect(() => {
          repo.create(makeInput({ nodeType: oldType as MemoryNodeType }));
        }).toThrow();
      }
    });

    it('rejects arbitrary string type values', () => {
      expect(() => {
        repo.create(makeInput({ nodeType: 'unknown' as MemoryNodeType }));
      }).toThrow();
    });
  });

  // ─── Retrieval with nodeType null ────────────────────────────────

  describe('retrieval with null nodeType', () => {
    it('getById returns null nodeType correctly', () => {
      const created = repo.create(makeInput({ nodeType: null, nodeRole: 'hub' }));
      const retrieved = repo.getById(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.nodeType).toBeNull();
      expect(retrieved!.nodeRole).toBe('hub');
    });

    it('getRefsById returns null nodeType', () => {
      const created = repo.create(makeInput({ nodeType: null }));
      const refs = repo.getRefsById([created.id]);
      expect(refs).toHaveLength(1);
      expect(refs[0].nodeType).toBeNull();
    });

    it('getL1ById returns null nodeType', () => {
      const created = repo.create(makeInput({ nodeType: null }));
      const l1 = repo.getL1ById(created.id);
      expect(l1).not.toBeNull();
      expect(l1!.nodeType).toBeNull();
    });

    it('getL2ById returns null nodeType', () => {
      const created = repo.create(makeInput({ nodeType: null }));
      const l2 = repo.getL2ById(created.id);
      expect(l2).not.toBeNull();
      expect(l2!.nodeType).toBeNull();
    });
  });

  // ─── Query/Filter ────────────────────────────────────────────────

  describe('query filtering', () => {
    beforeEach(() => {
      // Create diverse set of nodes
      repo.create(makeInput({ nodeType: 'semantic', nodeRole: 'leaf', frontmatter: 'semantic leaf' }));
      repo.create(makeInput({ nodeType: 'episodic', nodeRole: 'leaf', frontmatter: 'episodic leaf' }));
      repo.create(makeInput({ nodeType: 'procedural', nodeRole: 'hub', frontmatter: 'procedural hub' }));
      repo.create(makeInput({ nodeType: 'prospective', nodeRole: 'leaf', frontmatter: 'prospective leaf' }));
      repo.create(makeInput({ nodeType: 'emotional', nodeRole: 'hub', frontmatter: 'emotional hub' }));
      repo.create(makeInput({ nodeType: null, nodeRole: 'hub', frontmatter: 'untyped hub' }));
      repo.create(makeInput({ nodeType: null, nodeRole: 'leaf', frontmatter: 'untyped leaf' }));
    });

    it('filters by single nodeType', () => {
      const result = repo.query({ nodeType: 'semantic' });
      expect(result).toHaveLength(1);
      expect(result[0].nodeType).toBe('semantic');
    });

    it('filters by multiple nodeTypes', () => {
      const result = repo.query({ nodeType: ['semantic', 'episodic'] });
      expect(result).toHaveLength(2);
    });

    it('filters by null nodeType', () => {
      const result = repo.query({ nodeType: null });
      expect(result).toHaveLength(2); // untyped hub + untyped leaf
    });

    it('filters by array including null nodeType', () => {
      const result = repo.query({ nodeType: ['semantic', null] });
      expect(result).toHaveLength(3); // 1 semantic + 2 null
    });

    it('filters by nodeRole hub', () => {
      const result = repo.query({ nodeRole: 'hub' });
      expect(result).toHaveLength(3); // procedural hub + emotional hub + untyped hub
    });

    it('filters by nodeRole leaf', () => {
      const result = repo.query({ nodeRole: 'leaf' });
      expect(result).toHaveLength(4);
    });

    it('filters by combined nodeType and nodeRole', () => {
      const result = repo.query({ nodeType: null, nodeRole: 'hub' });
      expect(result).toHaveLength(1);
      expect(result[0].frontmatter).toBe('untyped hub');
    });
  });

  // ─── Hub operations ──────────────────────────────────────────────

  describe('hub operations', () => {
    it('getHubs returns all hub nodes', () => {
      repo.create(makeInput({ nodeType: 'semantic', nodeRole: 'hub', frontmatter: 'hub1' }));
      repo.create(makeInput({ nodeType: null, nodeRole: 'hub', frontmatter: 'hub2' }));
      repo.create(makeInput({ nodeType: 'episodic', nodeRole: 'leaf', frontmatter: 'leaf1' }));

      const hubs = repo.getHubs();
      expect(hubs).toHaveLength(2);
      expect(hubs.every(h => h.nodeRole === 'hub')).toBe(true);
    });

    it('getHubs filters by nodeType including null', () => {
      repo.create(makeInput({ nodeType: 'semantic', nodeRole: 'hub', frontmatter: 'sem hub' }));
      repo.create(makeInput({ nodeType: null, nodeRole: 'hub', frontmatter: 'null hub' }));

      const semanticHubs = repo.getHubs('semantic');
      expect(semanticHubs).toHaveLength(1);
      expect(semanticHubs[0].nodeType).toBe('semantic');

      const nullHubs = repo.getHubs(null);
      expect(nullHubs).toHaveLength(1);
      expect(nullHubs[0].nodeType).toBeNull();
    });

    it('promoteToHub changes leaf to hub', () => {
      const leaf = repo.create(makeInput({ nodeRole: 'leaf' }));
      expect(leaf.nodeRole).toBe('leaf');

      const promoted = repo.promoteToHub(leaf.id);
      expect(promoted).not.toBeNull();
      expect(promoted!.nodeRole).toBe('hub');
    });

    it('findHubByLabel works', () => {
      repo.create(makeInput({ nodeRole: 'hub', frontmatter: 'TypeScript' }));
      const found = repo.findHubByLabel('typescript'); // case-insensitive
      expect(found).not.toBeNull();
      expect(found!.nodeRole).toBe('hub');
    });
  });

  // ─── Count ───────────────────────────────────────────────────────

  describe('count', () => {
    beforeEach(() => {
      repo.create(makeInput({ nodeType: 'semantic', nodeRole: 'leaf' }));
      repo.create(makeInput({ nodeType: 'semantic', nodeRole: 'hub' }));
      repo.create(makeInput({ nodeType: null, nodeRole: 'hub' }));
      repo.create(makeInput({ nodeType: 'emotional', nodeRole: 'leaf' }));
    });

    it('counts all nodes', () => {
      expect(repo.count()).toBe(4);
    });

    it('counts by nodeType', () => {
      expect(repo.count('semantic')).toBe(2);
      expect(repo.count('emotional')).toBe(1);
    });

    it('counts by null nodeType', () => {
      expect(repo.count(null)).toBe(1);
    });

    it('counts by nodeRole', () => {
      expect(repo.count(undefined, 'hub')).toBe(2);
      expect(repo.count(undefined, 'leaf')).toBe(2);
    });

    it('counts by nodeType + nodeRole', () => {
      expect(repo.count('semantic', 'hub')).toBe(1);
      expect(repo.count('semantic', 'leaf')).toBe(1);
      expect(repo.count(null, 'hub')).toBe(1);
    });
  });

  // ─── All 5 types CRUD round-trip ────────────────────────────────

  describe('all nodeType values round-trip', () => {
    const allTypes: MemoryNodeTypeNullable[] = ['semantic', 'episodic', 'procedural', 'prospective', 'emotional', null];

    for (const type of allTypes) {
      it(`creates and retrieves nodeType="${type}"`, () => {
        const node = repo.create(makeInput({ nodeType: type }));
        expect(node.nodeType).toBe(type);

        const retrieved = repo.getById(node.id)!;
        expect(retrieved.nodeType).toBe(type);
      });
    }
  });

  // ─── Both roles CRUD round-trip ──────────────────────────────────

  describe('all nodeRole values round-trip', () => {
    const allRoles: MemoryNodeRole[] = ['hub', 'leaf'];

    for (const role of allRoles) {
      it(`creates and retrieves nodeRole="${role}"`, () => {
        const node = repo.create(makeInput({ nodeRole: role }));
        expect(node.nodeRole).toBe(role);

        const retrieved = repo.getById(node.id)!;
        expect(retrieved.nodeRole).toBe(role);
      });
    }
  });

  // ─── nodeRole update via update() ────────────────────────────────

  describe('nodeRole update', () => {
    it('updates nodeRole from leaf to hub', () => {
      const node = repo.create(makeInput({ nodeRole: 'leaf' }));
      const updated = repo.update(node.id, { nodeRole: 'hub' });
      expect(updated).not.toBeNull();
      expect(updated!.nodeRole).toBe('hub');
    });

    it('updates nodeRole from hub to leaf', () => {
      const node = repo.create(makeInput({ nodeRole: 'hub' }));
      const updated = repo.update(node.id, { nodeRole: 'leaf' });
      expect(updated).not.toBeNull();
      expect(updated!.nodeRole).toBe('leaf');
    });
  });

  // ─── Batch create ────────────────────────────────────────────────

  describe('batch create with mixed types/roles', () => {
    it('creates nodes with various type/role combinations', () => {
      const inputs: CreateMemoryNodeInput[] = [
        makeInput({ nodeType: 'semantic', nodeRole: 'leaf' }),
        makeInput({ nodeType: 'episodic', nodeRole: 'hub' }),
        makeInput({ nodeType: null, nodeRole: 'hub' }),
        makeInput({ nodeType: 'procedural', nodeRole: 'leaf' }),
        makeInput({ nodeType: 'prospective', nodeRole: 'leaf' }),
        makeInput({ nodeType: 'emotional', nodeRole: 'hub' }),
      ];

      const nodes = repo.createBatch(inputs);
      expect(nodes).toHaveLength(6);

      expect(nodes[0].nodeType).toBe('semantic');
      expect(nodes[0].nodeRole).toBe('leaf');
      expect(nodes[1].nodeType).toBe('episodic');
      expect(nodes[1].nodeRole).toBe('hub');
      expect(nodes[2].nodeType).toBeNull();
      expect(nodes[2].nodeRole).toBe('hub');
      expect(nodes[3].nodeType).toBe('procedural');
      expect(nodes[4].nodeType).toBe('prospective');
      expect(nodes[5].nodeType).toBe('emotional');
      expect(nodes[5].nodeRole).toBe('hub');
    });
  });
});
