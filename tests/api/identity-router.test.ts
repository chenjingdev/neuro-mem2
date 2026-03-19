import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { CREATE_IDENTITY_TABLES } from '../../src/db/identity-schema.js'
import { HumanIdentityRepository } from '../../src/db/human-identity-repo.js'
import { AgentIdentityRepository } from '../../src/db/agent-identity-repo.js'
import { createIdentityRouter } from '../../src/api/identity-router.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(CREATE_IDENTITY_TABLES)
  return db
}

describe('Identity Router', () => {
  let app: Hono
  let db: Database.Database
  let humanRepo: HumanIdentityRepository
  let agentRepo: AgentIdentityRepository

  beforeEach(() => {
    db = createTestDb()
    humanRepo = new HumanIdentityRepository(db)
    agentRepo = new AgentIdentityRepository(db)
    const router = createIdentityRouter({ humanRepo, agentRepo })
    app = new Hono()
    app.route('/api/identity', router)
  })

  describe('POST /api/identity/human', () => {
    it('creates human identity', async () => {
      const res = await app.request('/api/identity/human', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ humanId: 'user-1' }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.humanId).toBe('user-1')
    })
  })

  describe('GET /api/identity/human/:id', () => {
    it('returns human identity', async () => {
      const created = humanRepo.create({ humanId: 'user-1' })
      const res = await app.request(`/api/identity/human/${created.id}`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe(created.id)
    })

    it('returns 404 for non-existent', async () => {
      const res = await app.request('/api/identity/human/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/identity/agent', () => {
    it('creates agent identity', async () => {
      const res = await app.request('/api/identity/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          persona: { archetype: 'test', description: 'test', seedSource: 'manual' },
        }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.persona.archetype).toBe('test')
    })
  })

  describe('GET /api/identity/agent/:id', () => {
    it('returns agent identity', async () => {
      const created = agentRepo.create({
        persona: { archetype: 'test', description: 'test', seedSource: 'manual' },
      })
      const res = await app.request(`/api/identity/agent/${created.id}`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe(created.id)
    })
  })

  describe('PUT /api/identity/human/:id', () => {
    it('updates human identity', async () => {
      const created = humanRepo.create({ humanId: 'user-1' })
      const res = await app.request(`/api/identity/human/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traits: [{ trait: 'new', confidence: 0.5, sourceNodeIds: [] }] }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.traits).toHaveLength(1)
      expect(body.version).toBe(2)
    })
  })

  describe('DELETE /api/identity/human/:id', () => {
    it('deletes human identity', async () => {
      const created = humanRepo.create({ humanId: 'user-1' })
      const res = await app.request(`/api/identity/human/${created.id}`, { method: 'DELETE' })
      expect(res.status).toBe(200)
    })
  })

  describe('GET /api/identity/human/by-human-id/:humanId', () => {
    it('returns identity by humanId', async () => {
      humanRepo.create({ humanId: 'user-1' })
      const res = await app.request('/api/identity/human/by-human-id/user-1')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.humanId).toBe('user-1')
    })
  })

  describe('PUT /api/identity/agent/:id', () => {
    it('updates agent identity', async () => {
      const created = agentRepo.create({
        persona: { archetype: 'test', description: 'test', seedSource: 'manual' },
      })
      const res = await app.request(`/api/identity/agent/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.name).toBe('Updated')
    })
  })

  describe('DELETE /api/identity/agent/:id', () => {
    it('deletes agent identity', async () => {
      const created = agentRepo.create({
        persona: { archetype: 'test', description: 'test', seedSource: 'manual' },
      })
      const res = await app.request(`/api/identity/agent/${created.id}`, { method: 'DELETE' })
      expect(res.status).toBe(200)
    })
  })

  describe('GET /api/identity/agent/:id/history', () => {
    it('returns evolution history', async () => {
      const created = agentRepo.create({
        persona: { archetype: 'test', description: 'test', seedSource: 'manual' },
      })
      agentRepo.addEvolutionEntry({
        identityId: created.id,
        identityType: 'agent',
        version: 2,
        changes: ['test change'],
        triggeredBy: 'test',
      })
      const res = await app.request(`/api/identity/agent/${created.id}/history`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveLength(1)
    })
  })
})
