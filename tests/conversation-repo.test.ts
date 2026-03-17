/**
 * Comprehensive tests for ConversationRepository — the Raw Conversation Storage layer.
 *
 * Covers:
 * - Full CRUD operations
 * - Immutability guarantees
 * - Range/pagination queries
 * - Search and filtering
 * - Edge cases (empty, large, unicode)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import type { IngestConversationInput, AppendMessageInput } from '../src/models/conversation.js';

describe('ConversationRepository', () => {
  let db: Database.Database;
  let repo: ConversationRepository;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    repo = new ConversationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Helper ──

  function ingestSample(overrides: Partial<IngestConversationInput> = {}) {
    return repo.ingest({
      source: 'test',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
      ...overrides,
    });
  }

  // ── Ingest (Create) ──

  describe('ingest', () => {
    it('stores conversation with all messages atomically', () => {
      const conv = ingestSample({ title: 'My Chat' });

      expect(conv.id).toBeTruthy();
      expect(conv.title).toBe('My Chat');
      expect(conv.source).toBe('test');
      expect(conv.messages).toHaveLength(2);
      expect(conv.messages[0]!.role).toBe('user');
      expect(conv.messages[1]!.role).toBe('assistant');
    });

    it('assigns sequential turn indices starting from 0', () => {
      const conv = repo.ingest({
        source: 'test',
        messages: [
          { role: 'system', content: 'System prompt' },
          { role: 'user', content: 'Q1' },
          { role: 'assistant', content: 'A1' },
          { role: 'user', content: 'Q2' },
          { role: 'assistant', content: 'A2' },
        ],
      });

      for (let i = 0; i < conv.messages.length; i++) {
        expect(conv.messages[i]!.turnIndex).toBe(i);
      }
    });

    it('generates unique UUIDs for conversation and each message', () => {
      const c1 = ingestSample();
      const c2 = ingestSample();

      expect(c1.id).not.toBe(c2.id);

      const allIds = [...c1.messages, ...c2.messages].map(m => m.id);
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    });

    it('accepts and uses a custom conversation ID', () => {
      const conv = repo.ingest({
        id: 'custom-id-abc',
        source: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(conv.id).toBe('custom-id-abc');
    });

    it('stores metadata as JSON and round-trips correctly', () => {
      const conv = repo.ingest({
        source: 'test',
        metadata: { model: 'claude-3.5', tags: ['dev', 'ts'] },
        messages: [
          { role: 'user', content: 'hi', metadata: { tokens: 5 } },
        ],
      });

      const fetched = repo.getConversation(conv.id);
      expect(fetched!.metadata).toEqual({ model: 'claude-3.5', tags: ['dev', 'ts'] });
      expect(fetched!.messages[0]!.metadata).toEqual({ tokens: 5 });
    });

    it('preserves special characters and unicode in content', () => {
      const content = '한국어 日本語 العربية\n```ts\nconst x = 42;\n```\nEmoji: 🎉🚀';
      const conv = repo.ingest({
        source: 'test',
        messages: [{ role: 'user', content }],
      });

      const fetched = repo.getMessage(conv.messages[0]!.id);
      expect(fetched!.content).toBe(content);
    });

    it('handles very large messages (100KB)', () => {
      const largeContent = 'A'.repeat(100_000);
      const conv = repo.ingest({
        source: 'test',
        messages: [{ role: 'user', content: largeContent }],
      });

      const fetched = repo.getMessage(conv.messages[0]!.id);
      expect(fetched!.content.length).toBe(100_000);
    });
  });

  // ── appendMessage ──

  describe('appendMessage', () => {
    it('appends with correct next turn index', () => {
      const conv = ingestSample(); // turns 0, 1
      const msg = repo.appendMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'Follow-up',
      });

      expect(msg.turnIndex).toBe(2);
      expect(msg.conversationId).toBe(conv.id);
    });

    it('updates conversation updatedAt timestamp', () => {
      const conv = ingestSample();
      const originalUpdated = conv.updatedAt;

      repo.appendMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'Later message',
      });

      const fetched = repo.getConversation(conv.id);
      expect(fetched!.updatedAt >= originalUpdated).toBe(true);
    });

    it('preserves all existing messages when appending', () => {
      const conv = ingestSample();
      const origIds = conv.messages.map(m => m.id);

      repo.appendMessage({ conversationId: conv.id, role: 'user', content: 'New' });

      const fetched = repo.getConversation(conv.id);
      expect(fetched!.messages).toHaveLength(3);
      expect(fetched!.messages[0]!.id).toBe(origIds[0]);
      expect(fetched!.messages[1]!.id).toBe(origIds[1]);
    });

    it('supports appending many messages sequentially', () => {
      const conv = repo.ingest({
        source: 'test',
        messages: [{ role: 'user', content: 'Start' }],
      });

      for (let i = 1; i <= 20; i++) {
        const role = i % 2 === 0 ? 'user' as const : 'assistant' as const;
        repo.appendMessage({ conversationId: conv.id, role, content: `Turn ${i}` });
      }

      expect(repo.countMessages(conv.id)).toBe(21);
      const last = repo.getLatestMessages(conv.id, 1);
      expect(last[0]!.turnIndex).toBe(20);
    });
  });

  // ── Read operations ──

  describe('getConversation', () => {
    it('returns full conversation with messages ordered by turn index', () => {
      const conv = ingestSample();
      const fetched = repo.getConversation(conv.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.messages).toHaveLength(2);
      expect(fetched!.messages[0]!.turnIndex).toBe(0);
      expect(fetched!.messages[1]!.turnIndex).toBe(1);
    });

    it('returns null for non-existent ID', () => {
      expect(repo.getConversation('nonexistent')).toBeNull();
    });
  });

  describe('getMessage', () => {
    it('retrieves a single message by ID', () => {
      const conv = ingestSample();
      const msgId = conv.messages[0]!.id;

      const msg = repo.getMessage(msgId);
      expect(msg).not.toBeNull();
      expect(msg!.id).toBe(msgId);
      expect(msg!.content).toBe('Hello');
    });

    it('returns null for non-existent message ID', () => {
      expect(repo.getMessage('no-such-msg')).toBeNull();
    });
  });

  describe('getMessages', () => {
    it('returns messages ordered by turn index', () => {
      const conv = repo.ingest({
        source: 'test',
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Second' },
          { role: 'user', content: 'Third' },
        ],
      });

      const msgs = repo.getMessages(conv.id);
      expect(msgs.map(m => m.content)).toEqual(['First', 'Second', 'Third']);
    });

    it('returns empty array for non-existent conversation', () => {
      expect(repo.getMessages('nonexistent')).toEqual([]);
    });
  });

  // ── New range/latest queries ──

  describe('getMessagesInRange', () => {
    it('returns messages within specified turn range inclusive', () => {
      const conv = repo.ingest({
        source: 'test',
        messages: [
          { role: 'user', content: 'T0' },
          { role: 'assistant', content: 'T1' },
          { role: 'user', content: 'T2' },
          { role: 'assistant', content: 'T3' },
          { role: 'user', content: 'T4' },
        ],
      });

      const range = repo.getMessagesInRange(conv.id, 1, 3);
      expect(range).toHaveLength(3);
      expect(range[0]!.content).toBe('T1');
      expect(range[2]!.content).toBe('T3');
    });

    it('returns empty for out-of-bounds range', () => {
      const conv = ingestSample(); // 2 messages (0, 1)
      const range = repo.getMessagesInRange(conv.id, 5, 10);
      expect(range).toEqual([]);
    });

    it('handles single-turn range', () => {
      const conv = ingestSample();
      const range = repo.getMessagesInRange(conv.id, 0, 0);
      expect(range).toHaveLength(1);
      expect(range[0]!.turnIndex).toBe(0);
    });
  });

  describe('getLatestMessages', () => {
    it('returns last N messages in chronological order', () => {
      const conv = repo.ingest({
        source: 'test',
        messages: [
          { role: 'user', content: 'A' },
          { role: 'assistant', content: 'B' },
          { role: 'user', content: 'C' },
          { role: 'assistant', content: 'D' },
          { role: 'user', content: 'E' },
        ],
      });

      const latest = repo.getLatestMessages(conv.id, 3);
      expect(latest).toHaveLength(3);
      expect(latest[0]!.content).toBe('C');
      expect(latest[1]!.content).toBe('D');
      expect(latest[2]!.content).toBe('E');
    });

    it('returns all messages if limit exceeds count', () => {
      const conv = ingestSample(); // 2 msgs
      const latest = repo.getLatestMessages(conv.id, 100);
      expect(latest).toHaveLength(2);
    });
  });

  describe('getMaxTurnIndex', () => {
    it('returns highest turn index', () => {
      const conv = repo.ingest({
        source: 'test',
        messages: [
          { role: 'user', content: 'A' },
          { role: 'assistant', content: 'B' },
          { role: 'user', content: 'C' },
        ],
      });
      expect(repo.getMaxTurnIndex(conv.id)).toBe(2);
    });

    it('returns -1 for conversation with no messages', () => {
      // Edge: no messages for a non-existent conversation
      expect(repo.getMaxTurnIndex('nonexistent')).toBe(-1);
    });
  });

  // ── List/Search ──

  describe('listConversations', () => {
    it('returns conversations ordered by updatedAt DESC', () => {
      repo.ingest({ source: 'test', title: 'Old', messages: [{ role: 'user', content: 'x' }] });
      repo.ingest({ source: 'test', title: 'New', messages: [{ role: 'user', content: 'y' }] });

      const list = repo.listConversations();
      expect(list[0]!.title).toBe('New');
      expect(list[1]!.title).toBe('Old');
    });

    it('filters by source', () => {
      repo.ingest({ source: 'claude-code', messages: [{ role: 'user', content: 'a' }] });
      repo.ingest({ source: 'codex', messages: [{ role: 'user', content: 'b' }] });
      repo.ingest({ source: 'claude-code', messages: [{ role: 'user', content: 'c' }] });

      const filtered = repo.listConversations({ source: 'claude-code' });
      expect(filtered).toHaveLength(2);
      expect(filtered.every(c => c.source === 'claude-code')).toBe(true);
    });

    it('supports limit and offset pagination', () => {
      for (let i = 0; i < 10; i++) {
        repo.ingest({
          source: 'test',
          title: `Conv ${i}`,
          messages: [{ role: 'user', content: `msg ${i}` }],
        });
      }

      const p1 = repo.listConversations({ limit: 3, offset: 0 });
      const p2 = repo.listConversations({ limit: 3, offset: 3 });

      expect(p1).toHaveLength(3);
      expect(p2).toHaveLength(3);
      // No overlap
      const ids1 = new Set(p1.map(c => c.id));
      expect(p2.every(c => !ids1.has(c.id))).toBe(true);
    });

    it('returns conversations with empty messages array (lazy loading)', () => {
      ingestSample();
      const list = repo.listConversations();
      expect(list[0]!.messages).toEqual([]);
    });
  });

  describe('searchByTitle', () => {
    it('finds conversations by partial title match', () => {
      repo.ingest({ source: 'test', title: 'TypeScript Debugging', messages: [{ role: 'user', content: 'a' }] });
      repo.ingest({ source: 'test', title: 'Python Setup', messages: [{ role: 'user', content: 'b' }] });
      repo.ingest({ source: 'test', title: 'TypeScript Generics', messages: [{ role: 'user', content: 'c' }] });

      const results = repo.searchByTitle('TypeScript');
      expect(results).toHaveLength(2);
      expect(results.every(r => r.title!.includes('TypeScript'))).toBe(true);
    });

    it('is case-insensitive', () => {
      repo.ingest({ source: 'test', title: 'React Components', messages: [{ role: 'user', content: 'a' }] });

      const results = repo.searchByTitle('react');
      expect(results).toHaveLength(1);
    });

    it('returns empty array for no matches', () => {
      ingestSample();
      expect(repo.searchByTitle('nonexistent-xyz')).toEqual([]);
    });
  });

  describe('getConversationsUpdatedSince', () => {
    it('returns conversations updated after the given timestamp', () => {
      const pastTime = '2020-01-01T00:00:00.000Z';
      ingestSample();

      const results = repo.getConversationsUpdatedSince(pastTime);
      expect(results.length).toBeGreaterThan(0);
    });

    it('returns empty for future timestamp', () => {
      ingestSample();
      const results = repo.getConversationsUpdatedSince('2099-12-31T23:59:59.999Z');
      expect(results).toEqual([]);
    });
  });

  // ── Counts ──

  describe('counts', () => {
    it('countConversations returns correct count', () => {
      expect(repo.countConversations()).toBe(0);
      ingestSample();
      ingestSample();
      expect(repo.countConversations()).toBe(2);
    });

    it('countMessages returns correct count per conversation', () => {
      const c1 = ingestSample(); // 2 messages
      const c2 = repo.ingest({
        source: 'test',
        messages: [{ role: 'user', content: 'x' }],
      }); // 1 message

      expect(repo.countMessages(c1.id)).toBe(2);
      expect(repo.countMessages(c2.id)).toBe(1);
    });
  });

  // ── conversationExists ──

  describe('conversationExists', () => {
    it('returns true for existing conversation', () => {
      const conv = ingestSample();
      expect(repo.conversationExists(conv.id)).toBe(true);
    });

    it('returns false for non-existent conversation', () => {
      expect(repo.conversationExists('no-such-id')).toBe(false);
    });
  });

  // ── Immutability guarantees ──

  describe('immutability', () => {
    it('API has no update or delete methods for messages', () => {
      // Verify the repository does NOT expose message mutation
      const repoProto = Object.getOwnPropertyNames(ConversationRepository.prototype);
      expect(repoProto).not.toContain('updateMessage');
      expect(repoProto).not.toContain('deleteMessage');
      expect(repoProto).not.toContain('deleteConversation');
    });

    it('original messages remain unchanged after appending new ones', () => {
      const conv = ingestSample();
      const origContent0 = conv.messages[0]!.content;
      const origContent1 = conv.messages[1]!.content;
      const origId0 = conv.messages[0]!.id;

      // Append several messages
      for (let i = 0; i < 5; i++) {
        repo.appendMessage({ conversationId: conv.id, role: 'user', content: `New ${i}` });
      }

      // Verify originals are intact
      const msg0 = repo.getMessage(origId0);
      expect(msg0!.content).toBe(origContent0);

      const allMsgs = repo.getMessages(conv.id);
      expect(allMsgs[0]!.content).toBe(origContent0);
      expect(allMsgs[1]!.content).toBe(origContent1);
    });
  });

  // ── Transaction atomicity ──

  describe('transaction atomicity', () => {
    it('ingest is atomic — either all messages stored or none', () => {
      const countBefore = repo.countConversations();

      // Normal ingest should succeed atomically
      const conv = repo.ingest({
        source: 'test',
        messages: [
          { role: 'user', content: 'Msg 1' },
          { role: 'assistant', content: 'Msg 2' },
          { role: 'user', content: 'Msg 3' },
        ],
      });

      expect(repo.countConversations()).toBe(countBefore + 1);
      expect(repo.countMessages(conv.id)).toBe(3);
    });
  });
});
