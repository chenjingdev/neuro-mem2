import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { CREATE_IDENTITY_TABLES } from '../../src/db/identity-schema.js'
import { HumanIdentityRepository } from '../../src/db/human-identity-repo.js'
import type { CreateHumanIdentityInput } from '../../src/models/identity.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(CREATE_IDENTITY_TABLES)
  return db
}

function makeInput(overrides?: Partial<CreateHumanIdentityInput>): CreateHumanIdentityInput {
  return {
    humanId: 'human-1',
    traits: [{ trait: '실용주의적', confidence: 0.8, sourceNodeIds: ['n1'] }],
    coreValues: [{ value: '코드 품질', weight: 0.9, sourceNodeIds: ['n2'] }],
    communicationStyle: { preferred: ['간결한 답변'], avoided: ['장황한 설명'] },
    expertiseMap: [{ domain: 'React', level: 'expert', sourceNodeIds: ['n3'] }],
    currentFocus: [{ topic: 'neuro-mem2 개발', since: '2026-03-01', relatedNodeIds: ['n4'] }],
    ...overrides,
  }
}

describe('HumanIdentityRepository', () => {
  let db: Database.Database
  let repo: HumanIdentityRepository

  beforeEach(() => {
    db = createTestDb()
    repo = new HumanIdentityRepository(db)
  })

  describe('create', () => {
    it('creates identity and returns it', () => {
      const result = repo.create(makeInput())
      expect(result.id).toBeDefined()
      expect(result.humanId).toBe('human-1')
      expect(result.traits).toHaveLength(1)
      expect(result.traits[0].trait).toBe('실용주의적')
      expect(result.coreValues[0].value).toBe('코드 품질')
      expect(result.version).toBe(1)
    })

    it('creates identity with defaults when optional fields omitted', () => {
      const result = repo.create({ humanId: 'human-2' })
      expect(result.traits).toEqual([])
      expect(result.coreValues).toEqual([])
      expect(result.communicationStyle).toEqual({ preferred: [], avoided: [] })
      expect(result.expertiseMap).toEqual([])
      expect(result.currentFocus).toEqual([])
    })

    it('throws on duplicate humanId', () => {
      repo.create(makeInput())
      expect(() => repo.create(makeInput())).toThrow()
    })
  })

  describe('getById', () => {
    it('returns identity by id', () => {
      const created = repo.create(makeInput())
      const found = repo.getById(created.id)
      expect(found).not.toBeNull()
      expect(found!.humanId).toBe('human-1')
      expect(found!.traits).toEqual(created.traits)
    })

    it('returns null for non-existent id', () => {
      expect(repo.getById('nonexistent')).toBeNull()
    })
  })

  describe('getByHumanId', () => {
    it('returns identity by humanId', () => {
      repo.create(makeInput())
      const found = repo.getByHumanId('human-1')
      expect(found).not.toBeNull()
      expect(found!.humanId).toBe('human-1')
    })

    it('returns null for non-existent humanId', () => {
      expect(repo.getByHumanId('nonexistent')).toBeNull()
    })
  })

  describe('update', () => {
    it('updates traits and increments version', () => {
      const created = repo.create(makeInput())
      const updated = repo.update(created.id, {
        traits: [
          { trait: '실용주의적', confidence: 0.9, sourceNodeIds: ['n1', 'n5'] },
          { trait: '완벽주의', confidence: 0.6, sourceNodeIds: ['n6'] },
        ],
      })
      expect(updated).not.toBeNull()
      expect(updated!.traits).toHaveLength(2)
      expect(updated!.version).toBe(2)
      expect(updated!.coreValues).toEqual(created.coreValues)
    })

    it('returns null for non-existent id', () => {
      expect(repo.update('nonexistent', { traits: [] })).toBeNull()
    })
  })

  describe('delete', () => {
    it('deletes identity', () => {
      const created = repo.create(makeInput())
      expect(repo.delete(created.id)).toBe(true)
      expect(repo.getById(created.id)).toBeNull()
    })

    it('returns false for non-existent id', () => {
      expect(repo.delete('nonexistent')).toBe(false)
    })
  })

  describe('list', () => {
    it('returns all identities', () => {
      repo.create(makeInput({ humanId: 'h1' }))
      repo.create(makeInput({ humanId: 'h2' }))
      const list = repo.list()
      expect(list).toHaveLength(2)
    })
  })
})
