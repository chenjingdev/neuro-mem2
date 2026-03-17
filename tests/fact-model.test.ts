import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import type { CreateFactInput, Fact, FactCategory } from '../src/models/fact.js';
import { FACT_CATEGORIES } from '../src/models/fact.js';

describe('Fact Node Data Model', () => {
  let db: Database.Database;
  let factRepo: FactRepository;
  let convRepo: ConversationRepository;
  let conversationId: string;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    factRepo = new FactRepository(db);
    convRepo = new ConversationRepository(db);

    // Create a conversation to reference
    const conv = convRepo.ingest({
      source: 'test',
      title: 'Test conversation',
      messages: [
        { role: 'user', content: 'I prefer TypeScript for backends.' },
        { role: 'assistant', content: 'TypeScript is great for backends!' },
      ],
    });
    conversationId = conv.id;
  });

  afterEach(() => {
    db.close();
  });

  function makeInput(overrides?: Partial<CreateFactInput>): CreateFactInput {
    return {
      content: 'User prefers TypeScript for backend development',
      conversationId,
      sourceMessageIds: ['msg-1', 'msg-2'],
      sourceTurnIndex: 0,
      confidence: 0.95,
      category: 'preference',
      entities: ['TypeScript'],
      ...overrides,
    };
  }

  describe('Fact interface fields', () => {
    it('should contain all required fields: content, source_turn_id, timestamp, confidence', () => {
      const fact = factRepo.create(makeInput());

      // Required fields per AC 2.1
      expect(fact.id).toBeDefined();
      expect(typeof fact.id).toBe('string');
      expect(fact.content).toBe('User prefers TypeScript for backend development');
      expect(fact.sourceMessageIds).toEqual(['msg-1', 'msg-2']);
      expect(fact.sourceTurnIndex).toBe(0);
      expect(fact.createdAt).toBeDefined();
      expect(fact.updatedAt).toBeDefined();
      expect(fact.confidence).toBe(0.95);
    });

    it('should include conversationId linking back to raw conversation', () => {
      const fact = factRepo.create(makeInput());
      expect(fact.conversationId).toBe(conversationId);
    });

    it('should include category from the FactCategory enum', () => {
      const fact = factRepo.create(makeInput({ category: 'technical' }));
      expect(fact.category).toBe('technical');
    });

    it('should include entities array', () => {
      const fact = factRepo.create(makeInput({ entities: ['TypeScript', 'Node.js'] }));
      expect(fact.entities).toEqual(['TypeScript', 'Node.js']);
    });

    it('should include optional SPO triple fields', () => {
      const fact = factRepo.create(makeInput({
        subject: 'user',
        predicate: 'prefers',
        object: 'TypeScript',
      }));
      expect(fact.subject).toBe('user');
      expect(fact.predicate).toBe('prefers');
      expect(fact.object).toBe('TypeScript');
    });

    it('should default superseded to false', () => {
      const fact = factRepo.create(makeInput());
      expect(fact.superseded).toBe(false);
      expect(fact.supersededBy).toBeUndefined();
    });

    it('should support optional metadata', () => {
      const fact = factRepo.create(makeInput({
        metadata: { model: 'gpt-4', extractionVersion: 1 },
      }));
      expect(fact.metadata).toEqual({ model: 'gpt-4', extractionVersion: 1 });
    });
  });

  describe('FactCategory', () => {
    it('should enumerate all valid categories', () => {
      expect(FACT_CATEGORIES).toEqual([
        'preference', 'technical', 'requirement', 'decision',
        'context', 'instruction', 'knowledge', 'relationship', 'other',
      ]);
    });

    it('should accept all valid categories in DB', () => {
      for (const cat of FACT_CATEGORIES) {
        const fact = factRepo.create(makeInput({ category: cat }));
        expect(fact.category).toBe(cat);
      }
    });

    it('should reject invalid categories via DB constraint', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO facts (id, conversation_id, source_message_ids, source_turn_index,
            content, category, confidence, entities, superseded, created_at, updated_at)
          VALUES ('bad', ?, '[]', 0, 'test', 'invalid_category', 0.5, '[]', 0, datetime('now'), datetime('now'))
        `).run(conversationId);
      }).toThrow();
    });
  });

  describe('Confidence validation', () => {
    it('should accept confidence at boundaries [0.0, 1.0]', () => {
      const f0 = factRepo.create(makeInput({ confidence: 0.0 }));
      expect(f0.confidence).toBe(0.0);
      const f1 = factRepo.create(makeInput({ confidence: 1.0 }));
      expect(f1.confidence).toBe(1.0);
    });

    it('should reject confidence outside [0.0, 1.0] via DB constraint', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO facts (id, conversation_id, source_message_ids, source_turn_index,
            content, category, confidence, entities, superseded, created_at, updated_at)
          VALUES ('bad', ?, '[]', 0, 'test', 'other', 1.5, '[]', 0, datetime('now'), datetime('now'))
        `).run(conversationId);
      }).toThrow();

      expect(() => {
        db.prepare(`
          INSERT INTO facts (id, conversation_id, source_message_ids, source_turn_index,
            content, category, confidence, entities, superseded, created_at, updated_at)
          VALUES ('bad2', ?, '[]', 0, 'test', 'other', -0.1, '[]', 0, datetime('now'), datetime('now'))
        `).run(conversationId);
      }).toThrow();
    });
  });

  describe('CRUD operations', () => {
    it('should persist and retrieve a fact by ID', () => {
      const created = factRepo.create(makeInput());
      const retrieved = factRepo.getById(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.content).toBe(created.content);
      expect(retrieved!.confidence).toBe(created.confidence);
      expect(retrieved!.sourceMessageIds).toEqual(created.sourceMessageIds);
      expect(retrieved!.sourceTurnIndex).toBe(created.sourceTurnIndex);
    });

    it('should return null for non-existent fact ID', () => {
      expect(factRepo.getById('nonexistent')).toBeNull();
    });

    it('should create multiple facts in a transaction', () => {
      const inputs = [
        makeInput({ content: 'Fact 1', sourceTurnIndex: 0 }),
        makeInput({ content: 'Fact 2', sourceTurnIndex: 1 }),
        makeInput({ content: 'Fact 3', sourceTurnIndex: 2 }),
      ];

      const facts = factRepo.createMany(inputs);
      expect(facts).toHaveLength(3);
      expect(facts.map(f => f.content)).toEqual(['Fact 1', 'Fact 2', 'Fact 3']);
    });

    it('should get active facts by conversation', () => {
      factRepo.create(makeInput({ content: 'Active fact' }));
      const superseded = factRepo.create(makeInput({ content: 'Old fact' }));
      const newer = factRepo.create(makeInput({ content: 'New fact' }));
      factRepo.supersede(superseded.id, newer.id);

      const active = factRepo.getActiveByConversation(conversationId);
      expect(active.map(f => f.content)).toContain('Active fact');
      expect(active.map(f => f.content)).toContain('New fact');
      expect(active.map(f => f.content)).not.toContain('Old fact');
    });

    it('should get all facts including superseded', () => {
      factRepo.create(makeInput({ content: 'Active fact' }));
      const old = factRepo.create(makeInput({ content: 'Old fact' }));
      const newer = factRepo.create(makeInput({ content: 'New fact' }));
      factRepo.supersede(old.id, newer.id);

      const all = factRepo.getAllByConversation(conversationId);
      expect(all).toHaveLength(3);
    });

    it('should get facts by turn index', () => {
      factRepo.create(makeInput({ content: 'Turn 0 fact', sourceTurnIndex: 0 }));
      factRepo.create(makeInput({ content: 'Turn 1 fact', sourceTurnIndex: 1 }));

      const turn0 = factRepo.getByTurn(conversationId, 0);
      expect(turn0).toHaveLength(1);
      expect(turn0[0]!.content).toBe('Turn 0 fact');
    });

    it('should get facts by category', () => {
      factRepo.create(makeInput({ category: 'preference', content: 'Pref fact' }));
      factRepo.create(makeInput({ category: 'technical', content: 'Tech fact' }));

      const prefs = factRepo.getByCategory('preference', conversationId);
      expect(prefs).toHaveLength(1);
      expect(prefs[0]!.category).toBe('preference');
    });

    it('should update fact confidence', async () => {
      const fact = factRepo.create(makeInput({ confidence: 0.5 }));
      // Small delay to ensure updatedAt differs
      await new Promise(r => setTimeout(r, 5));
      const updated = factRepo.update(fact.id, { confidence: 0.9 });

      expect(updated).not.toBeNull();
      expect(updated!.confidence).toBe(0.9);
      expect(updated!.updatedAt >= fact.updatedAt).toBe(true);
    });

    it('should supersede a fact', () => {
      const old = factRepo.create(makeInput({ content: 'Old info' }));
      const newer = factRepo.create(makeInput({ content: 'Updated info' }));

      factRepo.supersede(old.id, newer.id);

      const retrieved = factRepo.getById(old.id);
      expect(retrieved!.superseded).toBe(true);
      expect(retrieved!.supersededBy).toBe(newer.id);
    });

    it('should count facts correctly', () => {
      factRepo.create(makeInput());
      factRepo.create(makeInput());
      const old = factRepo.create(makeInput());
      const newer = factRepo.create(makeInput());
      factRepo.supersede(old.id, newer.id);

      expect(factRepo.countByConversation(conversationId, true)).toBe(3); // active only
      expect(factRepo.countByConversation(conversationId, false)).toBe(4); // all
    });

    it('should delete a fact', () => {
      const fact = factRepo.create(makeInput());
      expect(factRepo.delete(fact.id)).toBe(true);
      expect(factRepo.getById(fact.id)).toBeNull();
      expect(factRepo.delete('nonexistent')).toBe(false);
    });
  });

  describe('ISO 8601 timestamps', () => {
    it('should generate valid ISO 8601 timestamps', () => {
      const fact = factRepo.create(makeInput());
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
      expect(fact.createdAt).toMatch(isoRegex);
      expect(fact.updatedAt).toMatch(isoRegex);
    });
  });
});
