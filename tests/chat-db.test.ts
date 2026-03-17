/**
 * Tests for chat DB schema and connection helpers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openChatDatabase, ensureChatTables, getChatSchemaVersion } from '../src/chat/db/connection.js';
import { CHAT_SCHEMA_VERSION, CREATE_CHAT_TABLES } from '../src/chat/db/schema.js';
import { v4 as uuid } from 'uuid';

describe('chat/db/schema', () => {
  it('exports a positive schema version', () => {
    expect(CHAT_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('getChatSchemaVersion returns the same value', () => {
    expect(getChatSchemaVersion()).toBe(CHAT_SCHEMA_VERSION);
  });
});

describe('chat/db/connection – openChatDatabase', () => {
  const dbs: Database.Database[] = [];

  afterEach(() => {
    for (const db of dbs) {
      try { db.close(); } catch { /* ignore */ }
    }
    dbs.length = 0;
  });

  function open(opts?: Parameters<typeof openChatDatabase>[0]) {
    const db = openChatDatabase(opts);
    dbs.push(db);
    return db;
  }

  it('creates an in-memory database with chat tables', () => {
    const db = open({ inMemory: true });

    // All three tables must exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('chat_conversations');
    expect(names).toContain('chat_messages');
    expect(names).toContain('chat_trace_events');
  });

  it('reuses an existing db handle and applies tables', () => {
    const raw = new Database(':memory:');
    dbs.push(raw);

    const db = open({ db: raw });
    expect(db).toBe(raw); // same handle

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('chat_conversations');
  });

  it('is idempotent — calling twice does not throw', () => {
    const db = open({ inMemory: true });
    expect(() => ensureChatTables(db)).not.toThrow();
  });

  it('enforces foreign keys', () => {
    const db = open({ inMemory: true });
    const fk = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(fk[0]?.foreign_keys ?? (fk as unknown as number)).toBeTruthy();
  });
});

describe('chat tables CRUD', () => {
  let db: Database.Database;

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  function open() {
    db = openChatDatabase({ inMemory: true });
    return db;
  }

  it('inserts and retrieves a conversation', () => {
    open();
    const id = uuid();
    db.prepare(
      `INSERT INTO chat_conversations (id, title, user_id) VALUES (?, ?, ?)`,
    ).run(id, 'Test conv', 'debug-user');

    const row = db
      .prepare('SELECT * FROM chat_conversations WHERE id = ?')
      .get(id) as Record<string, unknown>;

    expect(row.id).toBe(id);
    expect(row.title).toBe('Test conv');
    expect(row.user_id).toBe('debug-user');
    expect(row.created_at).toBeTruthy();
  });

  it('inserts and retrieves messages with role constraint', () => {
    open();
    const convId = uuid();
    db.prepare(
      `INSERT INTO chat_conversations (id, user_id) VALUES (?, ?)`,
    ).run(convId, 'debug-user');

    const msgId = uuid();
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, turn_index)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(msgId, convId, 'user', 'Hello', 0);

    const row = db
      .prepare('SELECT * FROM chat_messages WHERE id = ?')
      .get(msgId) as Record<string, unknown>;

    expect(row.role).toBe('user');
    expect(row.content).toBe('Hello');
    expect(row.turn_index).toBe(0);
  });

  it('rejects invalid role on chat_messages', () => {
    open();
    const convId = uuid();
    db.prepare(
      `INSERT INTO chat_conversations (id, user_id) VALUES (?, ?)`,
    ).run(convId, 'debug-user');

    expect(() =>
      db
        .prepare(
          `INSERT INTO chat_messages (id, conversation_id, role, content, turn_index)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(uuid(), convId, 'bot', 'bad role', 0),
    ).toThrow();
  });

  it('inserts and retrieves trace events', () => {
    open();
    const convId = uuid();
    const msgId = uuid();
    db.prepare(`INSERT INTO chat_conversations (id, user_id) VALUES (?, ?)`).run(
      convId,
      'debug-user',
    );
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, turn_index)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(msgId, convId, 'assistant', 'Hi', 1);

    db.prepare(
      `INSERT INTO chat_trace_events
         (conversation_id, message_id, trace_id, stage, status, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(convId, msgId, 1, 'vector_search', 'start', new Date().toISOString());

    db.prepare(
      `INSERT INTO chat_trace_events
         (conversation_id, message_id, trace_id, stage, status, duration_ms, output, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(convId, msgId, 2, 'vector_search', 'complete', 42.5, '{"matchedAnchors":[]}', new Date().toISOString());

    const rows = db
      .prepare('SELECT * FROM chat_trace_events WHERE message_id = ? ORDER BY trace_id')
      .all(msgId) as Record<string, unknown>[];

    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe('start');
    expect(rows[1]!.status).toBe('complete');
    expect(rows[1]!.duration_ms).toBe(42.5);
    expect(rows[1]!.output).toBe('{"matchedAnchors":[]}');
  });

  it('rejects invalid status on trace events', () => {
    open();
    const convId = uuid();
    const msgId = uuid();
    db.prepare(`INSERT INTO chat_conversations (id, user_id) VALUES (?, ?)`).run(
      convId,
      'debug-user',
    );
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, turn_index)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(msgId, convId, 'assistant', 'Hi', 0);

    expect(() =>
      db
        .prepare(
          `INSERT INTO chat_trace_events
             (conversation_id, message_id, trace_id, stage, status, timestamp)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(convId, msgId, 1, 'vector_search', 'INVALID', new Date().toISOString()),
    ).toThrow();
  });

  it('auto-increments trace event id', () => {
    open();
    const convId = uuid();
    const msgId = uuid();
    db.prepare(`INSERT INTO chat_conversations (id, user_id) VALUES (?, ?)`).run(
      convId,
      'debug-user',
    );
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, turn_index)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(msgId, convId, 'assistant', 'Hi', 0);

    const insert = db.prepare(
      `INSERT INTO chat_trace_events
         (conversation_id, message_id, trace_id, stage, status, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const r1 = insert.run(convId, msgId, 1, 'recall', 'start', new Date().toISOString());
    const r2 = insert.run(convId, msgId, 2, 'recall', 'complete', new Date().toISOString());

    expect(r2.lastInsertRowid).toBeGreaterThan(r1.lastInsertRowid as number);
  });

  it('stores optional fields (token_count, model, metadata)', () => {
    open();
    const convId = uuid();
    const msgId = uuid();
    db.prepare(`INSERT INTO chat_conversations (id, user_id, metadata) VALUES (?, ?, ?)`).run(
      convId,
      'debug-user',
      '{"provider":"openai"}',
    );
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, turn_index, token_count, model, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(msgId, convId, 'assistant', 'Reply', 1, 42, 'gpt-4o', 1234.5);

    const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(msgId) as Record<string, unknown>;
    expect(msg.token_count).toBe(42);
    expect(msg.model).toBe('gpt-4o');
    expect(msg.duration_ms).toBe(1234.5);

    const conv = db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(convId) as Record<string, unknown>;
    expect(conv.metadata).toBe('{"provider":"openai"}');
  });
});
