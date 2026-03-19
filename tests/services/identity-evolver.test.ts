import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { CREATE_IDENTITY_TABLES } from '../../src/db/identity-schema.js'
import { AgentIdentityRepository } from '../../src/db/agent-identity-repo.js'
import { HumanIdentityRepository } from '../../src/db/human-identity-repo.js'
import { IdentityEvolver } from '../../src/services/identity-evolver.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(CREATE_IDENTITY_TABLES)
  return db
}

describe('IdentityEvolver', () => {
  let db: Database.Database
  let humanRepo: HumanIdentityRepository
  let agentRepo: AgentIdentityRepository
  let evolver: IdentityEvolver

  beforeEach(() => {
    db = createTestDb()
    humanRepo = new HumanIdentityRepository(db)
    agentRepo = new AgentIdentityRepository(db)
    evolver = new IdentityEvolver(agentRepo)
  })

  describe('personality evolution', () => {
    it('clamps personality shift to maxPersonalityShiftPerCycle', () => {
      const agent = agentRepo.create({
        persona: { archetype: 'test', description: 'test', seedSource: 'manual' },
        personality: [{ axis: 'directness', value: 0.5, confidence: 0.7 }],
        evolutionConfig: { mode: 'autonomous', maxPersonalityShiftPerCycle: 0.1, minEvidenceForPrinciple: 3, maxTraitChangeRate: 0.2 },
      })

      const result = evolver.evolveAgent(agent.id, {
        personalityUpdates: [{ axis: 'directness', value: 1.0, confidence: 0.8 }],
        newPrinciples: [],
        narrativeUpdate: null,
        triggeredBy: 'test',
      })

      expect(result.ok).toBe(true)
      const updated = agentRepo.getById(agent.id)!
      const directness = updated.personality.find(p => p.axis === 'directness')!
      expect(directness.value).toBeCloseTo(0.6)
    })
  })

  describe('principle formation', () => {
    it('rejects principle with insufficient evidence', () => {
      const agent = agentRepo.create({
        persona: { archetype: 'test', description: 'test', seedSource: 'manual' },
        evolutionConfig: { mode: 'autonomous', maxPersonalityShiftPerCycle: 0.1, minEvidenceForPrinciple: 3, maxTraitChangeRate: 0.2 },
      })

      const result = evolver.evolveAgent(agent.id, {
        personalityUpdates: [],
        newPrinciples: [
          { principle: 'test principle', weight: 0.8, sourceNodeIds: ['n1', 'n2'] },
        ],
        narrativeUpdate: null,
        triggeredBy: 'test',
      })

      expect(result.ok).toBe(true)
      const updated = agentRepo.getById(agent.id)!
      expect(updated.principles).toHaveLength(0)
    })

    it('accepts principle with sufficient evidence', () => {
      const agent = agentRepo.create({
        persona: { archetype: 'test', description: 'test', seedSource: 'manual' },
        evolutionConfig: { mode: 'autonomous', maxPersonalityShiftPerCycle: 0.1, minEvidenceForPrinciple: 3, maxTraitChangeRate: 0.2 },
      })

      const result = evolver.evolveAgent(agent.id, {
        personalityUpdates: [],
        newPrinciples: [
          { principle: 'good principle', weight: 0.8, sourceNodeIds: ['n1', 'n2', 'n3'] },
        ],
        narrativeUpdate: null,
        triggeredBy: 'test',
      })

      expect(result.ok).toBe(true)
      const updated = agentRepo.getById(agent.id)!
      expect(updated.principles).toHaveLength(1)
    })
  })

  describe('nonexistent agent', () => {
    it('returns error for nonexistent agent id', () => {
      const result = evolver.evolveAgent('nonexistent', {
        personalityUpdates: [],
        newPrinciples: [],
        narrativeUpdate: null,
        triggeredBy: 'test',
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('not found')
    })
  })

  describe('evolution history', () => {
    it('records evolution entry', () => {
      const agent = agentRepo.create({
        persona: { archetype: 'test', description: 'test', seedSource: 'manual' },
        personality: [{ axis: 'directness', value: 0.5, confidence: 0.7 }],
      })

      evolver.evolveAgent(agent.id, {
        personalityUpdates: [{ axis: 'directness', value: 0.6, confidence: 0.8 }],
        newPrinciples: [],
        narrativeUpdate: null,
        triggeredBy: 'consolidation-1',
      })

      const history = agentRepo.getEvolutionHistory(agent.id, 'agent')
      expect(history).toHaveLength(1)
      expect(history[0].triggeredBy).toBe('consolidation-1')
    })
  })
})
