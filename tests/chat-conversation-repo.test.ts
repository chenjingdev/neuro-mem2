/**
 * Tests for chat/db/conversationRepo — CRUD operations for
 * debug chat conversations and messages, plus convenience functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openChatDatabase } from '../src/chat/db/connection.js';
import {
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
  deleteConversation,
  createMessage,
  getMessagesByConversation,
  getMessage,
  getNextTurnIndex,
  getMessageCount,
  deleteMessage,
  saveChatTurn,
  getOrCreateConversation,
} from '../src/chat/db/conversationRepo.js';
import { v4 as uuidv4 } from 'uuid';

// ─── Test setup ──────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = openChatDatabase({ inMemory: true });
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
});

// ─── Conversation CRUD ───────────────────────────────────

describe('createConversation', () => {
  it('creates a conversation with all fields', () => {
    const conv = createConversation(db, {
      id: 'conv-1',
      title: 'Test Chat',
      sessionId: 'session-1',
      userId: 'debug-user',
      metadata: { source: 'test' },
    });

    expect(conv.id).toBe('conv-1');
    expect(conv.title).toBe('Test Chat');
    expect(conv.sessionId).toBe('session-1');
    expect(conv.userId).toBe('debug-user');
    expect(conv.metadata).toEqual({ source: 'test' });
    expect(conv.createdAt).toBeTruthy();
    expect(conv.updatedAt).toBeTruthy();
  });

  it('uses default userId when not provided', () => {
    const conv = createConversation(db, { id: 'conv-2' });
    expect(conv.userId).toBe('debug-user');
  });

  it('allows null title and sessionId', () => {
    const conv = createConversation(db, { id: 'conv-3' });
    expect(conv.title).toBeNull();
    expect(conv.sessionId).toBeNull();
  });
});

describe('getConversation', () => {
  it('returns a created conversation', () => {
    createConversation(db, { id: 'conv-1', title: 'Hello' });
    const found = getConversation(db, 'conv-1');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('conv-1');
    expect(found!.title).toBe('Hello');
  });

  it('returns null for non-existent ID', () => {
    expect(getConversation(db, 'does-not-exist')).toBeNull();
  });
});

describe('listConversations', () => {
  it('lists conversations ordered by updated_at DESC', () => {
    createConversation(db, { id: 'conv-old' });
    createConversation(db, { id: 'conv-new' });

    const list = listConversations(db);
    expect(list.length).toBe(2);
    // Most recent first
    expect(list[0].id).toBe('conv-new');
  });

  it('filters by userId', () => {
    createConversation(db, { id: 'c1', userId: 'alice' });
    createConversation(db, { id: 'c2', userId: 'bob' });

    const aliceConvs = listConversations(db, { userId: 'alice' });
    expect(aliceConvs.length).toBe(1);
    expect(aliceConvs[0].id).toBe('c1');
  });

  it('supports limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      createConversation(db, { id: `c${i}` });
    }
    const page = listConversations(db, { limit: 2, offset: 1 });
    expect(page.length).toBe(2);
  });

  it('includes message count', () => {
    createConversation(db, { id: 'conv-1' });
    createMessage(db, { id: 'm1', conversationId: 'conv-1', role: 'user', content: 'hi', turnIndex: 0 });
    createMessage(db, { id: 'm2', conversationId: 'conv-1', role: 'assistant', content: 'hello', turnIndex: 1 });

    const list = listConversations(db);
    expect(list[0].messageCount).toBe(2);
  });
});

describe('updateConversation', () => {
  it('updates title', () => {
    createConversation(db, { id: 'conv-1' });
    const updated = updateConversation(db, 'conv-1', { title: 'New Title' });
    expect(updated).toBe(true);

    const conv = getConversation(db, 'conv-1')!;
    expect(conv.title).toBe('New Title');
  });

  it('returns false for non-existent conversation', () => {
    expect(updateConversation(db, 'nope', { title: 'x' })).toBe(false);
  });
});

describe('deleteConversation', () => {
  it('deletes conversation and its messages', () => {
    createConversation(db, { id: 'conv-1' });
    createMessage(db, { id: 'm1', conversationId: 'conv-1', role: 'user', content: 'hi', turnIndex: 0 });

    expect(deleteConversation(db, 'conv-1')).toBe(true);
    expect(getConversation(db, 'conv-1')).toBeNull();
    expect(getMessagesByConversation(db, 'conv-1')).toHaveLength(0);
  });

  it('returns false for non-existent conversation', () => {
    expect(deleteConversation(db, 'nope')).toBe(false);
  });
});

// ─── Message CRUD ────────────────────────────────────────

describe('createMessage', () => {
  it('creates a message and touches parent conversation', () => {
    const conv = createConversation(db, { id: 'conv-1' });
    const originalUpdatedAt = conv.updatedAt;

    // Small delay to ensure timestamp difference
    const msg = createMessage(db, {
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'user',
      content: 'Hello world',
      turnIndex: 0,
      tokenCount: 5,
      model: 'gpt-4',
    });

    expect(msg.id).toBe('msg-1');
    expect(msg.conversationId).toBe('conv-1');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hello world');
    expect(msg.turnIndex).toBe(0);
    expect(msg.tokenCount).toBe(5);
    expect(msg.model).toBe('gpt-4');

    // Verify parent conversation was touched
    const updated = getConversation(db, 'conv-1')!;
    expect(updated.updatedAt).toBeTruthy();
  });

  it('stores metadata as JSON', () => {
    createConversation(db, { id: 'conv-1' });
    const msg = createMessage(db, {
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Hi',
      turnIndex: 1,
      metadata: { provider: 'openai', model: 'gpt-4' },
    });

    const retrieved = getMessage(db, 'msg-1')!;
    expect(retrieved.metadata).toEqual({ provider: 'openai', model: 'gpt-4' });
  });
});

describe('getMessagesByConversation', () => {
  it('returns messages ordered by turn_index', () => {
    createConversation(db, { id: 'conv-1' });
    createMessage(db, { id: 'm2', conversationId: 'conv-1', role: 'assistant', content: 'reply', turnIndex: 1 });
    createMessage(db, { id: 'm1', conversationId: 'conv-1', role: 'user', content: 'hello', turnIndex: 0 });

    const messages = getMessagesByConversation(db, 'conv-1');
    expect(messages.length).toBe(2);
    expect(messages[0].turnIndex).toBe(0);
    expect(messages[1].turnIndex).toBe(1);
  });

  it('returns empty array for conversation with no messages', () => {
    createConversation(db, { id: 'conv-1' });
    expect(getMessagesByConversation(db, 'conv-1')).toHaveLength(0);
  });

  it('supports limit and offset', () => {
    createConversation(db, { id: 'conv-1' });
    for (let i = 0; i < 10; i++) {
      createMessage(db, { id: `m${i}`, conversationId: 'conv-1', role: 'user', content: `msg ${i}`, turnIndex: i });
    }
    const page = getMessagesByConversation(db, 'conv-1', { limit: 3, offset: 2 });
    expect(page.length).toBe(3);
    expect(page[0].turnIndex).toBe(2);
  });
});

describe('getMessage', () => {
  it('returns null for non-existent message', () => {
    expect(getMessage(db, 'does-not-exist')).toBeNull();
  });
});

// ─── Utility functions ───────────────────────────────────

describe('getNextTurnIndex', () => {
  it('returns 0 for empty conversation', () => {
    createConversation(db, { id: 'conv-1' });
    expect(getNextTurnIndex(db, 'conv-1')).toBe(0);
  });

  it('returns max+1 after messages are added', () => {
    createConversation(db, { id: 'conv-1' });
    createMessage(db, { id: 'm1', conversationId: 'conv-1', role: 'user', content: 'a', turnIndex: 0 });
    createMessage(db, { id: 'm2', conversationId: 'conv-1', role: 'assistant', content: 'b', turnIndex: 1 });
    expect(getNextTurnIndex(db, 'conv-1')).toBe(2);
  });

  it('handles gaps in turn indices', () => {
    createConversation(db, { id: 'conv-1' });
    createMessage(db, { id: 'm1', conversationId: 'conv-1', role: 'user', content: 'a', turnIndex: 0 });
    createMessage(db, { id: 'm2', conversationId: 'conv-1', role: 'user', content: 'b', turnIndex: 5 });
    expect(getNextTurnIndex(db, 'conv-1')).toBe(6);
  });
});

describe('getMessageCount', () => {
  it('returns 0 for empty conversation', () => {
    createConversation(db, { id: 'conv-1' });
    expect(getMessageCount(db, 'conv-1')).toBe(0);
  });

  it('returns correct count', () => {
    createConversation(db, { id: 'conv-1' });
    createMessage(db, { id: 'm1', conversationId: 'conv-1', role: 'user', content: 'a', turnIndex: 0 });
    createMessage(db, { id: 'm2', conversationId: 'conv-1', role: 'assistant', content: 'b', turnIndex: 1 });
    expect(getMessageCount(db, 'conv-1')).toBe(2);
  });
});

describe('deleteMessage', () => {
  it('deletes a message by ID', () => {
    createConversation(db, { id: 'conv-1' });
    createMessage(db, { id: 'm1', conversationId: 'conv-1', role: 'user', content: 'a', turnIndex: 0 });

    expect(deleteMessage(db, 'm1')).toBe(true);
    expect(getMessage(db, 'm1')).toBeNull();
  });

  it('returns false for non-existent message', () => {
    expect(deleteMessage(db, 'nope')).toBe(false);
  });
});

// ─── saveChatTurn ────────────────────────────────────────

describe('saveChatTurn', () => {
  it('saves user + assistant messages in a single transaction', () => {
    createConversation(db, { id: 'conv-1' });

    const result = saveChatTurn(db, {
      conversationId: 'conv-1',
      userMessage: 'What is 2+2?',
      assistantMessage: '4',
      model: 'gpt-4',
      durationMs: 150.5,
      tokenCount: 10,
    });

    expect(result.userMessageId).toBeTruthy();
    expect(result.assistantMessageId).toBeTruthy();
    expect(result.turnIndex).toBe(0);

    const messages = getMessagesByConversation(db, 'conv-1');
    expect(messages.length).toBe(2);

    // User message
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('What is 2+2?');
    expect(messages[0].turnIndex).toBe(0);

    // Assistant message
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('4');
    expect(messages[1].turnIndex).toBe(1);
    expect(messages[1].model).toBe('gpt-4');
    expect(messages[1].durationMs).toBe(150.5);
    expect(messages[1].tokenCount).toBe(10);
  });

  it('auto-increments turn indices for multiple turns', () => {
    createConversation(db, { id: 'conv-1' });

    const r1 = saveChatTurn(db, {
      conversationId: 'conv-1',
      userMessage: 'Turn 1 user',
      assistantMessage: 'Turn 1 assistant',
    });
    expect(r1.turnIndex).toBe(0);

    const r2 = saveChatTurn(db, {
      conversationId: 'conv-1',
      userMessage: 'Turn 2 user',
      assistantMessage: 'Turn 2 assistant',
    });
    expect(r2.turnIndex).toBe(2);

    const messages = getMessagesByConversation(db, 'conv-1');
    expect(messages.length).toBe(4);
    expect(messages.map(m => m.turnIndex)).toEqual([0, 1, 2, 3]);
  });

  it('stores metadata on assistant message', () => {
    createConversation(db, { id: 'conv-1' });

    const result = saveChatTurn(db, {
      conversationId: 'conv-1',
      userMessage: 'hi',
      assistantMessage: 'hello',
      metadata: { provider: 'anthropic' },
    });

    const msg = getMessage(db, result.assistantMessageId)!;
    expect(msg.metadata).toEqual({ provider: 'anthropic' });
  });
});

// ─── getOrCreateConversation ─────────────────────────────

describe('getOrCreateConversation', () => {
  it('returns existing conversation when ID matches', () => {
    createConversation(db, { id: 'conv-1', title: 'Existing' });

    const conv = getOrCreateConversation(db, { conversationId: 'conv-1' });
    expect(conv.id).toBe('conv-1');
    expect(conv.title).toBe('Existing');
  });

  it('creates new conversation when ID does not exist', () => {
    const conv = getOrCreateConversation(db, {
      conversationId: 'new-conv',
      sessionId: 'session-1',
      userId: 'debug-user',
    });

    expect(conv.id).toBe('new-conv');
    expect(conv.sessionId).toBe('session-1');
  });

  it('creates new conversation with auto-generated ID when no ID provided', () => {
    const conv = getOrCreateConversation(db, {
      sessionId: 'session-x',
    });

    expect(conv.id).toBeTruthy();
    expect(conv.id.length).toBeGreaterThan(0);
    expect(conv.sessionId).toBe('session-x');
  });

  it('uses default userId', () => {
    const conv = getOrCreateConversation(db, {});
    expect(conv.userId).toBe('debug-user');
  });
});

// ─── Integration: full conversation lifecycle ────────────

describe('conversation lifecycle integration', () => {
  it('create → add turns → list → delete', () => {
    // Create
    const conv = createConversation(db, { id: 'lifecycle-conv', title: 'Lifecycle Test' });
    expect(conv.id).toBe('lifecycle-conv');

    // Add multiple turns
    saveChatTurn(db, {
      conversationId: conv.id,
      userMessage: 'What is memory?',
      assistantMessage: 'Memory is the cognitive process of storing and retrieving information.',
      model: 'gpt-4',
    });

    saveChatTurn(db, {
      conversationId: conv.id,
      userMessage: 'Tell me more',
      assistantMessage: 'There are different types of memory: episodic, semantic, and procedural.',
      model: 'claude-3',
    });

    // Verify messages
    const messages = getMessagesByConversation(db, conv.id);
    expect(messages.length).toBe(4);
    expect(getMessageCount(db, conv.id)).toBe(4);

    // List conversations
    const list = listConversations(db);
    expect(list.length).toBe(1);
    expect(list[0].messageCount).toBe(4);

    // Update title
    updateConversation(db, conv.id, { title: 'Updated Title' });
    expect(getConversation(db, conv.id)!.title).toBe('Updated Title');

    // Delete
    expect(deleteConversation(db, conv.id)).toBe(true);
    expect(getConversation(db, conv.id)).toBeNull();
    expect(getMessagesByConversation(db, conv.id)).toHaveLength(0);
  });
});
