import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  AgentIdentity,
  CreateAgentIdentityInput,
  UpdateAgentIdentityInput,
  IdentityEvolutionEntry,
} from '../models/identity.js'
import { DEFAULT_EVOLUTION_CONFIG } from '../models/identity.js'

export class AgentIdentityRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateAgentIdentityInput): AgentIdentity {
    const id = randomUUID()
    const now = new Date().toISOString()
    const config = { ...DEFAULT_EVOLUTION_CONFIG, ...input.evolutionConfig }

    this.db.prepare(`
      INSERT INTO agent_identities
        (id, paired_human_identity_id, name, persona, personality, principles,
         behavioral, voice, self_narrative, evolution_config, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      input.pairedHumanIdentityId ?? null,
      input.name ?? null,
      JSON.stringify(input.persona),
      JSON.stringify(input.personality ?? []),
      JSON.stringify(input.principles ?? []),
      JSON.stringify(input.behavioral ?? []),
      JSON.stringify(input.voice ?? { defaultTone: '', adaptations: [] }),
      JSON.stringify(input.selfNarrative ?? { origin: '', keyExperiences: [], currentUnderstanding: '' }),
      JSON.stringify(config),
      now,
      now,
    )

    return this.getById(id)!
  }

  getById(id: string): AgentIdentity | null {
    const row = this.db.prepare('SELECT * FROM agent_identities WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.rowToIdentity(row) : null
  }

  update(id: string, input: UpdateAgentIdentityInput): AgentIdentity | null {
    const existing = this.getById(id)
    if (!existing) return null

    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE agent_identities SET
        name = ?,
        persona = ?,
        personality = ?,
        principles = ?,
        behavioral = ?,
        voice = ?,
        self_narrative = ?,
        evolution_config = ?,
        version = version + 1,
        updated_at = ?
      WHERE id = ?
    `).run(
      input.name !== undefined ? input.name : existing.name,
      JSON.stringify(input.persona ?? existing.persona),
      JSON.stringify(input.personality ?? existing.personality),
      JSON.stringify(input.principles ?? existing.principles),
      JSON.stringify(input.behavioral ?? existing.behavioral),
      JSON.stringify(input.voice ?? existing.voice),
      JSON.stringify(input.selfNarrative ?? existing.selfNarrative),
      JSON.stringify(
        input.evolutionConfig
          ? { ...existing.evolutionConfig, ...input.evolutionConfig }
          : existing.evolutionConfig
      ),
      now,
      id,
    )

    return this.getById(id)
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM agent_identities WHERE id = ?').run(id)
    return result.changes > 0
  }

  list(): AgentIdentity[] {
    const rows = this.db.prepare('SELECT * FROM agent_identities ORDER BY created_at DESC').all() as Record<string, unknown>[]
    return rows.map(row => this.rowToIdentity(row))
  }

  // === Evolution History ===

  addEvolutionEntry(input: Omit<IdentityEvolutionEntry, 'id' | 'createdAt'>): IdentityEvolutionEntry {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO identity_evolution_history
        (id, identity_id, identity_type, version, changes, triggered_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.identityId, input.identityType, input.version, JSON.stringify(input.changes), input.triggeredBy, now)

    return { id, ...input, createdAt: now }
  }

  getEvolutionHistory(identityId: string, identityType: 'human' | 'agent', limit = 50): IdentityEvolutionEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM identity_evolution_history
      WHERE identity_id = ? AND identity_type = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(identityId, identityType, limit) as Record<string, unknown>[]

    return rows.map(row => ({
      id: row.id as string,
      identityId: row.identity_id as string,
      identityType: row.identity_type as 'human' | 'agent',
      version: row.version as number,
      changes: JSON.parse(row.changes as string),
      triggeredBy: row.triggered_by as string,
      createdAt: row.created_at as string,
    }))
  }

  private rowToIdentity(row: Record<string, unknown>): AgentIdentity {
    return {
      id: row.id as string,
      pairedHumanIdentityId: row.paired_human_identity_id as string | null,
      name: row.name as string | null,
      persona: JSON.parse(row.persona as string),
      personality: JSON.parse(row.personality as string),
      principles: JSON.parse(row.principles as string),
      behavioral: JSON.parse(row.behavioral as string),
      voice: JSON.parse(row.voice as string),
      selfNarrative: JSON.parse(row.self_narrative as string),
      evolutionConfig: JSON.parse(row.evolution_config as string),
      version: row.version as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }
}
