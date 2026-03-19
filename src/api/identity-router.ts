import { Hono } from 'hono'
import type { HumanIdentityRepository } from '../db/human-identity-repo.js'
import type { AgentIdentityRepository } from '../db/agent-identity-repo.js'
import type { IdentityEvolver } from '../services/identity-evolver.js'

export interface IdentityRouterDeps {
  humanRepo: HumanIdentityRepository
  agentRepo: AgentIdentityRepository
  evolver?: IdentityEvolver
}

export function createIdentityRouter(deps: IdentityRouterDeps): Hono {
  const { humanRepo, agentRepo } = deps
  const router = new Hono()

  // === Human Identity ===

  router.post('/human', async (c) => {
    const body = await c.req.json()
    const identity = humanRepo.create(body)
    return c.json(identity, 201)
  })

  router.get('/human', (c) => {
    return c.json(humanRepo.list())
  })

  router.get('/human/by-human-id/:humanId', (c) => {
    const identity = humanRepo.getByHumanId(c.req.param('humanId'))
    if (!identity) return c.json({ error: 'Not found' }, 404)
    return c.json(identity)
  })

  router.get('/human/:id', (c) => {
    const identity = humanRepo.getById(c.req.param('id'))
    if (!identity) return c.json({ error: 'Not found' }, 404)
    return c.json(identity)
  })

  router.put('/human/:id', async (c) => {
    const body = await c.req.json()
    const updated = humanRepo.update(c.req.param('id'), body)
    if (!updated) return c.json({ error: 'Not found' }, 404)
    return c.json(updated)
  })

  router.delete('/human/:id', (c) => {
    const deleted = humanRepo.delete(c.req.param('id'))
    if (!deleted) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true })
  })

  // === Agent Identity ===

  router.post('/agent', async (c) => {
    const body = await c.req.json()
    const identity = agentRepo.create(body)
    return c.json(identity, 201)
  })

  router.get('/agent', (c) => {
    return c.json(agentRepo.list())
  })

  router.get('/agent/:id/history', (c) => {
    const history = agentRepo.getEvolutionHistory(c.req.param('id'), 'agent')
    return c.json(history)
  })

  router.get('/agent/:id', (c) => {
    const identity = agentRepo.getById(c.req.param('id'))
    if (!identity) return c.json({ error: 'Not found' }, 404)
    return c.json(identity)
  })

  router.put('/agent/:id', async (c) => {
    const body = await c.req.json()
    const updated = agentRepo.update(c.req.param('id'), body)
    if (!updated) return c.json({ error: 'Not found' }, 404)
    return c.json(updated)
  })

  router.delete('/agent/:id', (c) => {
    const deleted = agentRepo.delete(c.req.param('id'))
    if (!deleted) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true })
  })

  // === Manual Evolve Trigger ===

  if (deps.evolver) {
    const evolver = deps.evolver
    router.post('/agent/:id/evolve', async (c) => {
      const body = await c.req.json()
      const result = evolver.evolveAgent(c.req.param('id'), body)
      if (!result.ok) return c.json({ error: result.error }, 404)
      return c.json(result)
    })
  }

  return router
}
