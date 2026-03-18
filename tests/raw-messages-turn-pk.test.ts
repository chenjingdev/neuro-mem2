/**
 * Tests for raw_messages turn-based composite PK redesign.
 *
 * Validates:
 * - raw_messages uses (conversation_id, turn_index) as composite PK
 * - No UUID `id` column exists on raw_messages
 * - RawMessage interface has no `id` field
 * - CRUD operations work with turn-based keys
 * - Duplicate (conversation_id, turn_index) is rejected
 * - Range queries work efficiently with the PK
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { CREATE_TABLES } from '../src/db/schema.js';
import type { RawMessage } from '../src/models/conversation.js';

describe('raw_messages turn-based PK', () => {
  let db: Database.Database;
  let repo: ConversationRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(CREATE_TABLES);
    repo = new ConversationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should create raw_messages table with composite PK (conversation_id, turn_index)', () => {
    const tableInfo = db.prepare("PRAGMA table_info('raw_messages')").all() as Array<{
      name: string; pk: number;
    }>;

    // Check composite PK: conversation_id (pk=1) and turn_index (pk=2)
    const pkColumns = tableInfo.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk);
    expect(pkColumns).toHaveLength(2);
    expect(pkColumns[0]!.name).toBe('conversation_id');
    expect(pkColumns[1]!.name).toBe('turn_index');

    // Verify no 'id' column exists
    const columnNames = tableInfo.map(c => c.name);
    expect(columnNames).not.toContain('id');
  });

  it('should have correct columns in raw_messages', () => {
    const tableInfo = db.prepare("PRAGMA table_info('raw_messages')").all() as Array<{
      name: string;
    }>;
    const columnNames = tableInfo.map(c => c.name);

    expect(columnNames).toEqual(expect.arrayContaining([
      'conversation_id',
      'turn_index',
      'role',
      'content',
      'created_at',
      'metadata',
    ]));
    expect(columnNames).toHaveLength(6);
  });

  it('should ingest a conversation with turn-based messages', () => {
    const conv = repo.ingest({
      source: 'test',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ],
    });

    expect(conv.messages).toHaveLength(3);

    // Messages should NOT have an 'id' field
    for (const msg of conv.messages) {
      expect(msg).not.toHaveProperty('id');
      expect(msg.conversationId).toBe(conv.id);
    }

    // Turn indices should be sequential
    expect(conv.messages[0]!.turnIndex).toBe(0);
    expect(conv.messages[1]!.turnIndex).toBe(1);
    expect(conv.messages[2]!.turnIndex).toBe(2);
  });

  it('should append messages with correct turn indices', () => {
    const conv = repo.ingest({
      source: 'test',
      messages: [
        { role: 'user', content: 'First' },
      ],
    });

    const msg2 = repo.appendMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: 'Response',
    });

    const msg3 = repo.appendMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'Follow-up',
    });

    expect(msg2.turnIndex).toBe(1);
    expect(msg3.turnIndex).toBe(2);
    expect(msg2).not.toHaveProperty('id');
  });

  it('should retrieve message by composite key (conversationId, turnIndex)', () => {
    const conv = repo.ingest({
      source: 'test',
      messages: [
        { role: 'user', content: 'Query' },
        { role: 'assistant', content: 'Answer' },
      ],
    });

    const msg = repo.getMessage(conv.id, 1);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('assistant');
    expect(msg!.content).toBe('Answer');
    expect(msg!.conversationId).toBe(conv.id);
    expect(msg!.turnIndex).toBe(1);
  });

  it('should return null for non-existent turn index', () => {
    const conv = repo.ingest({
      source: 'test',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const msg = repo.getMessage(conv.id, 99);
    expect(msg).toBeNull();
  });

  it('should reject duplicate (conversation_id, turn_index)', () => {
    const conv = repo.ingest({
      source: 'test',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    // Attempt to insert a duplicate turn
    expect(() => {
      db.prepare(`
        INSERT INTO raw_messages (conversation_id, turn_index, role, content, created_at)
        VALUES (?, 0, 'user', 'Duplicate', datetime('now'))
      `).run(conv.id);
    }).toThrow();
  });

  it('should support range queries via getMessagesInRange', () => {
    const conv = repo.ingest({
      source: 'test',
      messages: [
        { role: 'user', content: 'Turn 0' },
        { role: 'assistant', content: 'Turn 1' },
        { role: 'user', content: 'Turn 2' },
        { role: 'assistant', content: 'Turn 3' },
        { role: 'user', content: 'Turn 4' },
      ],
    });

    const range = repo.getMessagesInRange(conv.id, 1, 3);
    expect(range).toHaveLength(3);
    expect(range[0]!.content).toBe('Turn 1');
    expect(range[2]!.content).toBe('Turn 3');
  });

  it('should support getLatestMessages', () => {
    const conv = repo.ingest({
      source: 'test',
      messages: [
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
        { role: 'user', content: 'C' },
        { role: 'assistant', content: 'D' },
      ],
    });

    const latest = repo.getLatestMessages(conv.id, 2);
    expect(latest).toHaveLength(2);
    // Should be in chronological order
    expect(latest[0]!.content).toBe('C');
    expect(latest[1]!.content).toBe('D');
  });

  it('should preserve RawMessage interface without id field', () => {
    const msg: RawMessage = {
      conversationId: 'test-conv',
      turnIndex: 0,
      role: 'user',
      content: 'Test',
      createdAt: new Date().toISOString(),
    };

    // Type check: these should be the only required fields
    expect(msg.conversationId).toBeDefined();
    expect(msg.turnIndex).toBeDefined();
    expect(msg.role).toBeDefined();
    expect(msg.content).toBeDefined();
    expect(msg.createdAt).toBeDefined();

    // id should not exist
    expect((msg as Record<string, unknown>)['id']).toBeUndefined();
  });

  it('should handle metadata correctly with turn-based PK', () => {
    const conv = repo.ingest({
      source: 'test',
      messages: [
        { role: 'user', content: 'Hello', metadata: { tokenCount: 5 } },
      ],
    });

    const msg = repo.getMessage(conv.id, 0);
    expect(msg!.metadata).toEqual({ tokenCount: 5 });
  });

  it('should correctly count messages', () => {
    const conv = repo.ingest({
      source: 'test',
      messages: [
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
      ],
    });

    expect(repo.countMessages(conv.id)).toBe(2);

    repo.appendMessage({ conversationId: conv.id, role: 'user', content: 'C' });
    expect(repo.countMessages(conv.id)).toBe(3);
  });

  it('should correctly get max turn index', () => {
    const conv = repo.ingest({
      source: 'test',
      messages: [
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
      ],
    });

    expect(repo.getMaxTurnIndex(conv.id)).toBe(1);

    repo.appendMessage({ conversationId: conv.id, role: 'user', content: 'C' });
    expect(repo.getMaxTurnIndex(conv.id)).toBe(2);
  });
});
