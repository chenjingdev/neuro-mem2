// tests/db/identity-schema.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { CREATE_IDENTITY_TABLES } from '../../src/db/identity-schema.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(CREATE_IDENTITY_TABLES)
  return db
}

describe('Identity Schema', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
  })

  it('creates human_identities table', () => {
    const info = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='human_identities'"
    ).get() as { name: string } | undefined
    expect(info?.name).toBe('human_identities')
  })

  it('creates agent_identities table', () => {
    const info = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_identities'"
    ).get() as { name: string } | undefined
    expect(info?.name).toBe('agent_identities')
  })

  it('creates identity_evolution_history table', () => {
    const info = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='identity_evolution_history'"
    ).get() as { name: string } | undefined
    expect(info?.name).toBe('identity_evolution_history')
  })

  it('creates indexes', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all() as { name: string }[]
    const names = indexes.map(i => i.name)
    expect(names).toContain('idx_evolution_identity')
    expect(names).toContain('idx_human_identity_human_id')
  })

  it('enforces human_id UNIQUE constraint', () => {
    const insert = db.prepare(
      "INSERT INTO human_identities (id, human_id) VALUES (?, ?)"
    )
    insert.run('id1', 'human1')
    expect(() => insert.run('id2', 'human1')).toThrow()
  })

  it('enforces identity_type CHECK constraint', () => {
    const insert = db.prepare(
      "INSERT INTO identity_evolution_history (id, identity_id, identity_type, version, triggered_by) VALUES (?, ?, ?, ?, ?)"
    )
    expect(() => insert.run('e1', 'a1', 'invalid', 1, 'test')).toThrow()
  })

  it('is idempotent (can run CREATE twice)', () => {
    expect(() => db.exec(CREATE_IDENTITY_TABLES)).not.toThrow()
  })
})
