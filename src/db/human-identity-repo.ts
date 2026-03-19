import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  HumanIdentity,
  CreateHumanIdentityInput,
  UpdateHumanIdentityInput,
  HumanIdentityCommunicationStyle,
} from '../models/identity.js'

export class HumanIdentityRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateHumanIdentityInput): HumanIdentity {
    const id = randomUUID()
    const now = new Date().toISOString()
    const commStyle: HumanIdentityCommunicationStyle =
      input.communicationStyle ?? { preferred: [], avoided: [] }

    this.db.prepare(`
      INSERT INTO human_identities
        (id, human_id, traits, core_values, communication_style, expertise_map, current_focus, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      input.humanId,
      JSON.stringify(input.traits ?? []),
      JSON.stringify(input.coreValues ?? []),
      JSON.stringify(commStyle),
      JSON.stringify(input.expertiseMap ?? []),
      JSON.stringify(input.currentFocus ?? []),
      now,
      now,
    )

    return this.getById(id)!
  }

  getById(id: string): HumanIdentity | null {
    const row = this.db.prepare('SELECT * FROM human_identities WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.rowToIdentity(row) : null
  }

  getByHumanId(humanId: string): HumanIdentity | null {
    const row = this.db.prepare('SELECT * FROM human_identities WHERE human_id = ?').get(humanId) as Record<string, unknown> | undefined
    return row ? this.rowToIdentity(row) : null
  }

  update(id: string, input: UpdateHumanIdentityInput): HumanIdentity | null {
    const existing = this.getById(id)
    if (!existing) return null

    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE human_identities SET
        traits = ?,
        core_values = ?,
        communication_style = ?,
        expertise_map = ?,
        current_focus = ?,
        version = version + 1,
        updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(input.traits ?? existing.traits),
      JSON.stringify(input.coreValues ?? existing.coreValues),
      JSON.stringify(input.communicationStyle ?? existing.communicationStyle),
      JSON.stringify(input.expertiseMap ?? existing.expertiseMap),
      JSON.stringify(input.currentFocus ?? existing.currentFocus),
      now,
      id,
    )

    return this.getById(id)
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM human_identities WHERE id = ?').run(id)
    return result.changes > 0
  }

  list(): HumanIdentity[] {
    const rows = this.db.prepare('SELECT * FROM human_identities ORDER BY created_at DESC').all() as Record<string, unknown>[]
    return rows.map(row => this.rowToIdentity(row))
  }

  private rowToIdentity(row: Record<string, unknown>): HumanIdentity {
    return {
      id: row.id as string,
      humanId: row.human_id as string,
      traits: JSON.parse(row.traits as string),
      coreValues: JSON.parse(row.core_values as string),
      communicationStyle: JSON.parse(row.communication_style as string),
      expertiseMap: JSON.parse(row.expertise_map as string),
      currentFocus: JSON.parse(row.current_focus as string),
      version: row.version as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }
}
