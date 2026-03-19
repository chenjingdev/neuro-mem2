import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { CREATE_IDENTITY_TABLES } from '../../src/db/identity-schema.js'
import { AgentIdentityRepository } from '../../src/db/agent-identity-repo.js'
import type { CreateAgentIdentityInput } from '../../src/models/identity.js'
import { DEFAULT_EVOLUTION_CONFIG } from '../../src/models/identity.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(CREATE_IDENTITY_TABLES)
  return db
}

function makeInput(overrides?: Partial<CreateAgentIdentityInput>): CreateAgentIdentityInput {
  return {
    name: 'Nero',
    persona: {
      archetype: '직설적인 시니어 동료',
      description: '군더더기 없이 핵심만 짚는 시니어 엔지니어',
      seedSource: 'human_analysis',
    },
    personality: [
      { axis: 'directness', value: 0.8, confidence: 0.7 },
      { axis: 'warmth', value: 0.3, confidence: 0.5 },
    ],
    principles: [
      { principle: '단순한 해결책을 복잡한 것보다 우선한다', weight: 0.9, sourceNodeIds: ['n1'] },
    ],
    behavioral: [
      { trigger: '사용자가 막혀있을 때', tendency: '질문으로 유도', strength: 0.7 },
    ],
    voice: {
      defaultTone: '간결하고 약간 건조한',
      adaptations: [{ situation: '사용자가 좌절했을 때', tone: '부드럽고 공감적인' }],
    },
    selfNarrative: {
      origin: '사용자의 대화 패턴 분석에서 탄생',
      keyExperiences: [],
      currentUnderstanding: '나는 실용적 조언을 제공하는 동료다',
    },
    ...overrides,
  }
}

describe('AgentIdentityRepository', () => {
  let db: Database.Database
  let repo: AgentIdentityRepository

  beforeEach(() => {
    db = createTestDb()
    repo = new AgentIdentityRepository(db)
  })

  describe('create', () => {
    it('creates agent identity', () => {
      const result = repo.create(makeInput())
      expect(result.id).toBeDefined()
      expect(result.name).toBe('Nero')
      expect(result.persona.archetype).toBe('직설적인 시니어 동료')
      expect(result.personality).toHaveLength(2)
      expect(result.evolutionConfig).toEqual(DEFAULT_EVOLUTION_CONFIG)
      expect(result.version).toBe(1)
    })

    it('applies custom evolution config', () => {
      const result = repo.create(makeInput({
        evolutionConfig: { mode: 'supervised' },
      }))
      expect(result.evolutionConfig.mode).toBe('supervised')
      expect(result.evolutionConfig.maxPersonalityShiftPerCycle).toBe(0.1)
    })
  })

  describe('getById', () => {
    it('returns identity by id', () => {
      const created = repo.create(makeInput())
      const found = repo.getById(created.id)
      expect(found).not.toBeNull()
      expect(found!.persona).toEqual(created.persona)
      expect(found!.personality).toEqual(created.personality)
    })

    it('returns null for non-existent', () => {
      expect(repo.getById('nonexistent')).toBeNull()
    })
  })

  describe('update', () => {
    it('updates personality and increments version', () => {
      const created = repo.create(makeInput())
      const updated = repo.update(created.id, {
        personality: [
          { axis: 'directness', value: 0.9, confidence: 0.8 },
          { axis: 'warmth', value: 0.4, confidence: 0.6 },
        ],
      })
      expect(updated!.personality[0].value).toBe(0.9)
      expect(updated!.version).toBe(2)
      expect(updated!.principles).toEqual(created.principles)
    })
  })

  describe('evolution history', () => {
    it('records evolution entry', () => {
      const created = repo.create(makeInput())
      repo.addEvolutionEntry({
        identityId: created.id,
        identityType: 'agent',
        version: 2,
        changes: ['directness +0.1', 'new principle added'],
        triggeredBy: 'consolidation-job-1',
      })
      const history = repo.getEvolutionHistory(created.id, 'agent')
      expect(history).toHaveLength(1)
      expect(history[0].changes).toContain('directness +0.1')
    })

    it('returns history in reverse chronological order', () => {
      const created = repo.create(makeInput())
      repo.addEvolutionEntry({
        identityId: created.id,
        identityType: 'agent',
        version: 2,
        changes: ['first'],
        triggeredBy: 'job-1',
      })
      repo.addEvolutionEntry({
        identityId: created.id,
        identityType: 'agent',
        version: 3,
        changes: ['second'],
        triggeredBy: 'job-2',
      })
      const history = repo.getEvolutionHistory(created.id, 'agent')
      expect(history).toHaveLength(2)
      expect(history[0].version).toBe(3)
    })
  })

  describe('delete', () => {
    it('deletes identity', () => {
      const created = repo.create(makeInput())
      expect(repo.delete(created.id)).toBe(true)
      expect(repo.getById(created.id)).toBeNull()
    })
  })

  describe('list', () => {
    it('returns all agent identities', () => {
      repo.create(makeInput({ name: 'Agent-1' }))
      repo.create(makeInput({ name: 'Agent-2' }))
      expect(repo.list()).toHaveLength(2)
    })
  })
})
