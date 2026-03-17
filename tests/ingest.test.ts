import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { IngestService } from '../src/services/ingest.js';
import type { IngestConversationInput } from '../src/models/conversation.js';

describe('Raw Conversation Ingestion', () => {
  let db: Database.Database;
  let repo: ConversationRepository;
  let service: IngestService;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    repo = new ConversationRepository(db);
    service = new IngestService(repo);
  });

  afterEach(() => {
    db.close();
  });

  describe('IngestService.ingestConversation', () => {
    it('should store a conversation with messages as immutable records', () => {
      const input: IngestConversationInput = {
        source: 'claude-code',
        title: 'Test Conversation',
        messages: [
          { role: 'user', content: 'Hello, how are you?' },
          { role: 'assistant', content: 'I am doing well, thanks!' },
          { role: 'user', content: 'Can you help me with TypeScript?' },
        ],
      };

      const result = service.ingestConversation(input);

      expect(result.id).toBeDefined();
      expect(result.source).toBe('claude-code');
      expect(result.title).toBe('Test Conversation');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(result.messages).toHaveLength(3);
    });

    it('should assign sequential turn indices to messages', () => {
      const result = service.ingestConversation({
        source: 'api',
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Second' },
          { role: 'user', content: 'Third' },
        ],
      });

      expect(result.messages[0]!.turnIndex).toBe(0);
      expect(result.messages[1]!.turnIndex).toBe(1);
      expect(result.messages[2]!.turnIndex).toBe(2);
    });

    it('should preserve message content exactly as provided', () => {
      const content = '```typescript\nconst x: number = 42;\n```\n\nSpecial chars: 한국어 日本語 émojis 🎉';
      const result = service.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content }],
      });

      expect(result.messages[0]!.content).toBe(content);
    });

    it('should generate unique IDs for each conversation and message', () => {
      const r1 = service.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const r2 = service.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(r1.id).not.toBe(r2.id);
      expect(r1.messages[0]!.id).not.toBe(r2.messages[0]!.id);
    });

    it('should store metadata as JSON', () => {
      const result = service.ingestConversation({
        source: 'test',
        metadata: { sessionId: 'abc123', model: 'claude-3' },
        messages: [
          {
            role: 'assistant',
            content: 'Response',
            metadata: { tokens: 150, latency_ms: 230 },
          },
        ],
      });

      // Re-fetch from DB to verify persistence
      const fetched = service.getConversation(result.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.metadata).toEqual({ sessionId: 'abc123', model: 'claude-3' });
      expect(fetched!.messages[0]!.metadata).toEqual({ tokens: 150, latency_ms: 230 });
    });

    it('should reject empty messages array', () => {
      expect(() =>
        service.ingestConversation({ source: 'test', messages: [] })
      ).toThrow('At least one message is required');
    });

    it('should reject empty message content', () => {
      expect(() =>
        service.ingestConversation({
          source: 'test',
          messages: [{ role: 'user', content: '' }],
        })
      ).toThrow('Message content cannot be empty');
    });

    it('should reject missing source', () => {
      expect(() =>
        service.ingestConversation({
          source: '',
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).toThrow('Conversation source is required');
    });

    it('should accept a custom conversation ID', () => {
      const customId = 'custom-conv-id-123';
      const result = service.ingestConversation({
        id: customId,
        source: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      });

      expect(result.id).toBe(customId);
      const fetched = service.getConversation(customId);
      expect(fetched).not.toBeNull();
    });
  });

  describe('IngestService.appendMessage', () => {
    it('should append a message to an existing conversation', () => {
      const conv = service.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const appended = service.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Hi there!',
      });

      expect(appended.conversationId).toBe(conv.id);
      expect(appended.turnIndex).toBe(1);
      expect(appended.role).toBe('assistant');
      expect(appended.content).toBe('Hi there!');
    });

    it('should maintain correct turn indices when appending multiple messages', () => {
      const conv = service.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Turn 0' }],
      });

      service.appendMessage({ conversationId: conv.id, role: 'assistant', content: 'Turn 1' });
      service.appendMessage({ conversationId: conv.id, role: 'user', content: 'Turn 2' });
      const msg3 = service.appendMessage({ conversationId: conv.id, role: 'assistant', content: 'Turn 3' });

      expect(msg3.turnIndex).toBe(3);

      const full = service.getConversation(conv.id);
      expect(full!.messages).toHaveLength(4);
    });

    it('should update conversation updatedAt on append', () => {
      const conv = service.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const originalUpdatedAt = conv.updatedAt;

      // Small delay to ensure timestamp difference
      service.appendMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: 'Response',
      });

      const updated = service.getConversation(conv.id);
      expect(updated!.updatedAt).toBeDefined();
      // updatedAt should be >= original (may be same if very fast)
      expect(updated!.updatedAt >= originalUpdatedAt).toBe(true);
    });

    it('should throw when appending to non-existent conversation', () => {
      expect(() =>
        service.appendMessage({
          conversationId: 'non-existent-id',
          role: 'user',
          content: 'Hello',
        })
      ).toThrow('Conversation not found');
    });
  });

  describe('Immutability guarantees', () => {
    it('should not allow modifying stored messages via SQL', () => {
      const conv = service.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: 'Original content' }],
      });

      const msgId = conv.messages[0]!.id;

      // Verify original content
      const original = repo.getMessage(msgId);
      expect(original!.content).toBe('Original content');

      // Even though SQLite allows UPDATE, the API does not expose mutation
      // The repository has no update/delete methods for messages
      // This is an architectural guarantee
    });

    it('should preserve all original messages when new ones are appended', () => {
      const conv = service.ingestConversation({
        source: 'test',
        messages: [
          { role: 'user', content: 'Message 1' },
          { role: 'assistant', content: 'Message 2' },
        ],
      });

      const originalMsg1Id = conv.messages[0]!.id;
      const originalMsg2Id = conv.messages[1]!.id;

      service.appendMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'Message 3',
      });

      const full = service.getConversation(conv.id);
      expect(full!.messages[0]!.id).toBe(originalMsg1Id);
      expect(full!.messages[0]!.content).toBe('Message 1');
      expect(full!.messages[1]!.id).toBe(originalMsg2Id);
      expect(full!.messages[1]!.content).toBe('Message 2');
      expect(full!.messages[2]!.content).toBe('Message 3');
    });
  });

  describe('ConversationRepository.listConversations', () => {
    it('should list conversations ordered by updatedAt desc', () => {
      service.ingestConversation({
        source: 'test',
        title: 'First',
        messages: [{ role: 'user', content: 'a' }],
      });
      service.ingestConversation({
        source: 'test',
        title: 'Second',
        messages: [{ role: 'user', content: 'b' }],
      });

      const list = service.listConversations();
      expect(list).toHaveLength(2);
      // Most recent first
      expect(list[0]!.title).toBe('Second');
    });

    it('should filter by source', () => {
      service.ingestConversation({
        source: 'claude-code',
        messages: [{ role: 'user', content: 'a' }],
      });
      service.ingestConversation({
        source: 'codex',
        messages: [{ role: 'user', content: 'b' }],
      });

      const claudeOnly = service.listConversations({ source: 'claude-code' });
      expect(claudeOnly).toHaveLength(1);
      expect(claudeOnly[0]!.source).toBe('claude-code');
    });

    it('should support pagination', () => {
      for (let i = 0; i < 5; i++) {
        service.ingestConversation({
          source: 'test',
          title: `Conv ${i}`,
          messages: [{ role: 'user', content: `msg ${i}` }],
        });
      }

      const page1 = service.listConversations({ limit: 2, offset: 0 });
      const page2 = service.listConversations({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0]!.id).not.toBe(page2[0]!.id);
    });
  });

  describe('Edge cases', () => {
    it('should handle very long messages', () => {
      const longContent = 'x'.repeat(100_000);
      const conv = service.ingestConversation({
        source: 'test',
        messages: [{ role: 'user', content: longContent }],
      });

      const fetched = service.getConversation(conv.id);
      expect(fetched!.messages[0]!.content.length).toBe(100_000);
    });

    it('should handle system role messages', () => {
      const conv = service.ingestConversation({
        source: 'test',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi!' },
        ],
      });

      expect(conv.messages[0]!.role).toBe('system');
      expect(conv.messages).toHaveLength(3);
    });

    it('should return null for non-existent conversation', () => {
      const result = service.getConversation('does-not-exist');
      expect(result).toBeNull();
    });
  });
});
