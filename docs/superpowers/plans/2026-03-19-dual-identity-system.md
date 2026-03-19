# Dual Identity System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Agent Identity (agent's own self) and Human Identity (user modeling) as separate data models with extraction, evolution, and context composition.

**Architecture:** Two asymmetric identity models stored in SQLite with JSON columns, following existing Repository + EventBus patterns. Identity extraction uses LLM providers (same as MemoryNode extraction). ContextComposer extends the existing ContextInjector to inject both identities into LLM prompts.

**Tech Stack:** TypeScript (ESM), SQLite (better-sqlite3), Vitest, existing LLM Provider interface, EventBus

**Spec:** `docs/superpowers/specs/2026-03-19-dual-identity-system-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/models/identity.ts` | HumanIdentity, AgentIdentity, PersonalityAxis types |
| `src/db/identity-schema.ts` | SQL DDL for identity tables |
| `src/db/human-identity-repo.ts` | HumanIdentity CRUD |
| `src/db/agent-identity-repo.ts` | AgentIdentity CRUD + evolution history |
| `src/extraction/identity-extractor.ts` | LLM-based Human Identity extraction from MemoryNodes |
| `src/extraction/identity-extractor-prompt.ts` | System prompt for identity extraction |
| `src/extraction/persona-proposer.ts` | Generate Agent persona candidates from Human Identity |
| `src/extraction/persona-proposer-prompt.ts` | System prompt for persona proposal |
| `src/services/identity-evolver.ts` | Consolidation-time identity evolution |
| `src/services/context-composer.ts` | Compose Identity + Memory into LLM prompt |
| `src/api/identity-router.ts` | REST API endpoints for identity CRUD + evolve trigger |
| `tests/db/identity-schema.test.ts` | Schema creation tests |
| `tests/db/human-identity-repo.test.ts` | Human Identity repo tests |
| `tests/db/agent-identity-repo.test.ts` | Agent Identity repo tests |
| `tests/extraction/identity-extractor.test.ts` | Identity extraction tests |
| `tests/extraction/persona-proposer.test.ts` | Persona proposal tests |
| `tests/services/identity-evolver.test.ts` | Evolution logic tests |
| `tests/services/context-composer.test.ts` | Context composition tests |
| `tests/api/identity-router.test.ts` | API endpoint tests |

### Modified Files

| File | Change |
|------|--------|
| `src/db/connection.ts` | Add `CREATE_IDENTITY_TABLES` to schema init (line 57) |
| `src/events/event-bus.ts` | Add `IdentityUpdatedEvent` type to `MemoryEvent` union |
| `src/api/router.ts` | Add `identityDeps` to `RouterDependencies`, mount identity router |
| `src/index.ts` | Export new modules |
| `src/db/index.ts` | Add barrel exports for identity repos |
| `src/extraction/index.ts` | Add barrel exports for IdentityExtractor, PersonaProposer |
| `src/services/index.ts` | Add barrel exports for IdentityEvolver, ContextComposer |

---

## Task 1: Data Models

**Files:**
- Create: `src/models/identity.ts`

- [ ] **Step 1: Write type definitions**

```typescript
// src/models/identity.ts

// === Shared Types ===

export type PersonalityAxis =
  | 'directness'
  | 'warmth'
  | 'humor'
  | 'formality'
  | 'patience'
  | 'assertiveness'

export interface IdentityEvolutionEntry {
  id: string
  identityId: string
  identityType: 'human' | 'agent'
  version: number
  changes: string[]
  triggeredBy: string
  createdAt: string
}

// === Human Identity ===

export interface HumanIdentityTrait {
  trait: string
  confidence: number
  sourceNodeIds: string[]
}

export interface HumanIdentityCoreValue {
  value: string
  weight: number
  sourceNodeIds: string[]
}

export interface HumanIdentityCommunicationStyle {
  preferred: string[]
  avoided: string[]
}

export interface HumanIdentityExpertise {
  domain: string
  level: 'novice' | 'intermediate' | 'advanced' | 'expert'
  sourceNodeIds: string[]
}

export interface HumanIdentityFocus {
  topic: string
  since: string
  relatedNodeIds: string[]
}

export interface HumanIdentity {
  id: string
  humanId: string
  traits: HumanIdentityTrait[]
  coreValues: HumanIdentityCoreValue[]
  communicationStyle: HumanIdentityCommunicationStyle
  expertiseMap: HumanIdentityExpertise[]
  currentFocus: HumanIdentityFocus[]
  version: number
  createdAt: string
  updatedAt: string
}

export interface CreateHumanIdentityInput {
  humanId: string
  traits?: HumanIdentityTrait[]
  coreValues?: HumanIdentityCoreValue[]
  communicationStyle?: HumanIdentityCommunicationStyle
  expertiseMap?: HumanIdentityExpertise[]
  currentFocus?: HumanIdentityFocus[]
}

export interface UpdateHumanIdentityInput {
  traits?: HumanIdentityTrait[]
  coreValues?: HumanIdentityCoreValue[]
  communicationStyle?: HumanIdentityCommunicationStyle
  expertiseMap?: HumanIdentityExpertise[]
  currentFocus?: HumanIdentityFocus[]
}

// === Agent Identity ===

export interface AgentPersona {
  archetype: string
  description: string
  seedSource: 'human_analysis' | 'manual' | 'evolved'
}

export interface AgentPersonalityEntry {
  axis: PersonalityAxis | string
  value: number  // -1.0 to +1.0
  confidence: number
}

export interface AgentPrinciple {
  principle: string
  weight: number
  sourceNodeIds: string[]
}

export interface AgentBehavioralTendency {
  trigger: string
  tendency: string
  strength: number
}

export interface AgentVoice {
  defaultTone: string
  adaptations: {
    situation: string
    tone: string
  }[]
}

export interface AgentSelfNarrative {
  origin: string
  keyExperiences: {
    event: string
    impact: string
    date: string
  }[]
  currentUnderstanding: string
}

export interface IdentityEvolutionConfig {
  mode: 'autonomous' | 'supervised'
  maxPersonalityShiftPerCycle: number
  minEvidenceForPrinciple: number
  maxTraitChangeRate: number
}

export const DEFAULT_EVOLUTION_CONFIG: IdentityEvolutionConfig = {
  mode: 'autonomous',
  maxPersonalityShiftPerCycle: 0.1,
  minEvidenceForPrinciple: 3,
  maxTraitChangeRate: 0.2,
}

export interface AgentIdentity {
  id: string
  pairedHumanIdentityId: string | null
  name: string | null
  persona: AgentPersona
  personality: AgentPersonalityEntry[]
  principles: AgentPrinciple[]
  behavioral: AgentBehavioralTendency[]
  voice: AgentVoice
  selfNarrative: AgentSelfNarrative
  evolutionConfig: IdentityEvolutionConfig
  version: number
  createdAt: string
  updatedAt: string
}

export interface CreateAgentIdentityInput {
  pairedHumanIdentityId?: string
  name?: string
  persona: AgentPersona
  personality?: AgentPersonalityEntry[]
  principles?: AgentPrinciple[]
  behavioral?: AgentBehavioralTendency[]
  voice?: AgentVoice
  selfNarrative?: AgentSelfNarrative
  evolutionConfig?: Partial<IdentityEvolutionConfig>
}

export interface UpdateAgentIdentityInput {
  name?: string
  persona?: AgentPersona
  personality?: AgentPersonalityEntry[]
  principles?: AgentPrinciple[]
  behavioral?: AgentBehavioralTendency[]
  voice?: AgentVoice
  selfNarrative?: AgentSelfNarrative
  evolutionConfig?: Partial<IdentityEvolutionConfig>
}

// === Persona Proposal (for bootstrapping) ===

export interface PersonaCandidate {
  archetype: string
  description: string
  personality: AgentPersonalityEntry[]
  voice: AgentVoice
  reasoning: string  // Why this persona fits the user
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/models/identity.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/models/identity.ts
git commit -m "feat(identity): add HumanIdentity and AgentIdentity type definitions"
```

---

## Task 2: DB Schema

**Files:**
- Create: `src/db/identity-schema.ts`

- [ ] **Step 1: Write schema DDL**

```typescript
// src/db/identity-schema.ts

export const CREATE_IDENTITY_TABLES = `
CREATE TABLE IF NOT EXISTS human_identities (
  id TEXT PRIMARY KEY,
  human_id TEXT NOT NULL UNIQUE,
  traits TEXT NOT NULL DEFAULT '[]',
  core_values TEXT NOT NULL DEFAULT '[]',
  communication_style TEXT NOT NULL DEFAULT '{}',
  expertise_map TEXT NOT NULL DEFAULT '[]',
  current_focus TEXT NOT NULL DEFAULT '[]',
  version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_identities (
  id TEXT PRIMARY KEY,
  paired_human_identity_id TEXT REFERENCES human_identities(id),
  name TEXT,
  persona TEXT NOT NULL DEFAULT '{}',
  personality TEXT NOT NULL DEFAULT '[]',
  principles TEXT NOT NULL DEFAULT '[]',
  behavioral TEXT NOT NULL DEFAULT '[]',
  voice TEXT NOT NULL DEFAULT '{}',
  self_narrative TEXT NOT NULL DEFAULT '{}',
  evolution_config TEXT NOT NULL DEFAULT '{"mode":"autonomous","maxPersonalityShiftPerCycle":0.1,"minEvidenceForPrinciple":3,"maxTraitChangeRate":0.2}',
  version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS identity_evolution_history (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  identity_type TEXT NOT NULL CHECK(identity_type IN ('human', 'agent')),
  version INTEGER NOT NULL,
  changes TEXT NOT NULL DEFAULT '[]',
  triggered_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evolution_identity
  ON identity_evolution_history(identity_id, identity_type);

CREATE INDEX IF NOT EXISTS idx_human_identity_human_id
  ON human_identities(human_id);
`
```

- [ ] **Step 2: Write schema test**

```typescript
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
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run tests/db/identity-schema.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/db/identity-schema.ts tests/db/identity-schema.test.ts
git commit -m "feat(identity): add identity DB schema with tables and indexes"
```

---

## Task 3: HumanIdentityRepository

**Files:**
- Create: `src/db/human-identity-repo.ts`
- Create: `tests/db/human-identity-repo.test.ts`

- [ ] **Step 1: Write failing test for create + getById**

```typescript
// tests/db/human-identity-repo.test.ts
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
      // Unchanged fields preserved
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/human-identity-repo.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement HumanIdentityRepository**

```typescript
// src/db/human-identity-repo.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/db/human-identity-repo.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/human-identity-repo.ts tests/db/human-identity-repo.test.ts
git commit -m "feat(identity): add HumanIdentityRepository with full CRUD"
```

---

## Task 4: AgentIdentityRepository

**Files:**
- Create: `src/db/agent-identity-repo.ts`
- Create: `tests/db/agent-identity-repo.test.ts`

- [ ] **Step 1: Write failing test for create + getById + evolution history**

```typescript
// tests/db/agent-identity-repo.test.ts
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
      expect(result.evolutionConfig.maxPersonalityShiftPerCycle).toBe(0.1) // default preserved
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
      // Unchanged
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
      expect(history[0].version).toBe(3) // Most recent first
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/agent-identity-repo.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AgentIdentityRepository**

```typescript
// src/db/agent-identity-repo.ts
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
      ORDER BY created_at DESC
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/db/agent-identity-repo.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/agent-identity-repo.ts tests/db/agent-identity-repo.test.ts
git commit -m "feat(identity): add AgentIdentityRepository with CRUD and evolution history"
```

---

## Task 5: IdentityExtractor (LLM-based)

**Files:**
- Create: `src/extraction/identity-extractor.ts`
- Create: `src/extraction/identity-extractor-prompt.ts`
- Create: `tests/extraction/identity-extractor.test.ts`

- [ ] **Step 1: Write the LLM prompt**

```typescript
// src/extraction/identity-extractor-prompt.ts

export function buildIdentityExtractionPrompt(existingIdentity: string | null): string {
  const updateClause = existingIdentity
    ? `\n\n현재 Human Identity:\n${existingIdentity}\n\n위 기존 Identity를 기반으로 새 정보를 반영하여 업데이트하라. 기존 내용을 함부로 삭제하지 말고, 새 근거가 있을 때만 수정하라.`
    : ''

  return `당신은 대화에서 추출된 메모리 노드들을 분석하여 사용자(Human)의 Identity를 추출하는 전문가입니다.

주어진 MemoryNode 목록을 분석하여 다음을 추출하라:

1. **traits**: 성격 특성 (예: "실용주의적", "신중한", "완벽주의")
   - confidence: 근거의 강도 (0.0-1.0)
   - sourceNodeIds: 근거가 된 MemoryNode ID 배열

2. **coreValues**: 가치관 (예: "코드 품질", "사용자 경험", "빠른 실행")
   - weight: 중요도 (0.0-1.0)
   - sourceNodeIds: 근거 MemoryNode ID 배열

3. **communicationStyle**: 소통 패턴
   - preferred: 선호하는 소통 방식 배열
   - avoided: 피하는 소통 방식 배열

4. **expertiseMap**: 전문 영역
   - domain: 영역명
   - level: "novice" | "intermediate" | "advanced" | "expert"
   - sourceNodeIds: 근거 MemoryNode ID 배열

5. **currentFocus**: 현재 관심사/진행 중인 작업
   - topic: 주제
   - relatedNodeIds: 관련 MemoryNode ID 배열
${updateClause}

응답 형식 (JSON):
{
  "traits": [...],
  "coreValues": [...],
  "communicationStyle": { "preferred": [...], "avoided": [...] },
  "expertiseMap": [...],
  "currentFocus": [...]
}`
}

export function buildIdentityExtractionUserPrompt(nodes: { id: string; summary: string; frontmatter: string; keywords: string }[]): string {
  const nodeDescriptions = nodes.map(n =>
    `[${n.id}] ${n.frontmatter}\nKeywords: ${n.keywords}\nSummary: ${n.summary}`
  ).join('\n\n')

  return `다음 MemoryNode들을 분석하여 Human Identity를 추출하라:\n\n${nodeDescriptions}`
}
```

- [ ] **Step 2: Write failing test with mock LLM provider**

```typescript
// tests/extraction/identity-extractor.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { IdentityExtractor } from '../../src/extraction/identity-extractor.js'
import type { LLMProvider, LLMCompletionRequest, LLMCompletionResponse } from '../../src/extraction/llm-provider.js'

class MockLLMProvider implements LLMProvider {
  readonly name = 'mock'
  lastRequest: LLMCompletionRequest | null = null
  response: string = '{}'

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    this.lastRequest = request
    return { content: this.response, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }
  }
}

describe('IdentityExtractor', () => {
  let llm: MockLLMProvider
  let extractor: IdentityExtractor

  beforeEach(() => {
    llm = new MockLLMProvider()
    extractor = new IdentityExtractor(llm)
  })

  it('extracts identity from memory nodes', async () => {
    llm.response = JSON.stringify({
      traits: [{ trait: '실용주의적', confidence: 0.8, sourceNodeIds: ['n1'] }],
      coreValues: [{ value: '코드 품질', weight: 0.9, sourceNodeIds: ['n2'] }],
      communicationStyle: { preferred: ['간결한 답변'], avoided: [] },
      expertiseMap: [{ domain: 'TypeScript', level: 'advanced', sourceNodeIds: ['n3'] }],
      currentFocus: [{ topic: '메모리 시스템', relatedNodeIds: ['n1', 'n2'] }],
    })

    const result = await extractor.extractFromNodes([
      { id: 'n1', summary: 'React보다 실용적인 도구를 선호', frontmatter: 'preference', keywords: 'react pragmatic' },
      { id: 'n2', summary: '코드 품질에 대한 강한 의견', frontmatter: 'value', keywords: 'code quality' },
      { id: 'n3', summary: 'TypeScript 고급 패턴 사용', frontmatter: 'skill', keywords: 'typescript advanced' },
    ])

    expect(result.ok).toBe(true)
    expect(result.identity!.traits).toHaveLength(1)
    expect(result.identity!.traits[0].trait).toBe('실용주의적')
    expect(result.identity!.coreValues[0].value).toBe('코드 품질')
  })

  it('handles LLM error gracefully', async () => {
    llm.response = 'not valid json at all'
    const result = await extractor.extractFromNodes([
      { id: 'n1', summary: 'test', frontmatter: 'test', keywords: 'test' },
    ])
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('passes existing identity for incremental update', async () => {
    llm.response = JSON.stringify({
      traits: [{ trait: '실용주의적', confidence: 0.9, sourceNodeIds: ['n1', 'n4'] }],
      coreValues: [],
      communicationStyle: { preferred: [], avoided: [] },
      expertiseMap: [],
      currentFocus: [],
    })

    await extractor.extractFromNodes(
      [{ id: 'n4', summary: 'new info', frontmatter: 'info', keywords: 'new' }],
      { existingIdentityJson: '{"traits": [{"trait": "실용주의적"}]}' },
    )

    expect(llm.lastRequest!.system).toContain('현재 Human Identity')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/extraction/identity-extractor.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement IdentityExtractor**

```typescript
// src/extraction/identity-extractor.ts
import type { LLMProvider } from './llm-provider.js'
import type { UpdateHumanIdentityInput } from '../models/identity.js'
import {
  buildIdentityExtractionPrompt,
  buildIdentityExtractionUserPrompt,
} from './identity-extractor-prompt.js'

interface NodeSummary {
  id: string
  summary: string
  frontmatter: string
  keywords: string
}

interface ExtractionOptions {
  existingIdentityJson?: string
}

interface IdentityExtractionResult {
  ok: boolean
  identity: UpdateHumanIdentityInput | null
  error?: string
  rawResponse?: string
}

export class IdentityExtractor {
  constructor(private llm: LLMProvider) {}

  async extractFromNodes(
    nodes: NodeSummary[],
    options?: ExtractionOptions,
  ): Promise<IdentityExtractionResult> {
    if (nodes.length === 0) {
      return { ok: true, identity: null }
    }

    try {
      const system = buildIdentityExtractionPrompt(options?.existingIdentityJson ?? null)
      const prompt = buildIdentityExtractionUserPrompt(nodes)

      const response = await this.llm.complete({
        system,
        prompt,
        responseFormat: 'json',
        temperature: 0.1,
        maxTokens: 4096,
      })

      const parsed = this.parseResponse(response.content)
      return { ok: true, identity: parsed, rawResponse: response.content }
    } catch (err) {
      return {
        ok: false,
        identity: null,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private parseResponse(content: string): UpdateHumanIdentityInput {
    // Strip markdown code fences if present
    let json = content.trim()
    if (json.startsWith('```')) {
      json = json.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    }

    const data = JSON.parse(json)

    return {
      traits: Array.isArray(data.traits) ? data.traits : undefined,
      coreValues: Array.isArray(data.coreValues) ? data.coreValues : undefined,
      communicationStyle: data.communicationStyle ?? undefined,
      expertiseMap: Array.isArray(data.expertiseMap) ? data.expertiseMap : undefined,
      currentFocus: Array.isArray(data.currentFocus) ? data.currentFocus : undefined,
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/extraction/identity-extractor.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/extraction/identity-extractor.ts src/extraction/identity-extractor-prompt.ts tests/extraction/identity-extractor.test.ts
git commit -m "feat(identity): add LLM-based IdentityExtractor for Human Identity"
```

---

## Task 6: PersonaProposer

**Files:**
- Create: `src/extraction/persona-proposer.ts`
- Create: `src/extraction/persona-proposer-prompt.ts`
- Create: `tests/extraction/persona-proposer.test.ts`

- [ ] **Step 1: Write the LLM prompt**

```typescript
// src/extraction/persona-proposer-prompt.ts

export function buildPersonaProposalPrompt(): string {
  return `당신은 사용자 프로필을 분석하여 최적의 AI 에이전트 페르소나를 제안하는 전문가입니다.

주어진 Human Identity(사용자 프로필)를 분석하여, 이 사용자가 가장 편하게 소통하고 효과적으로 협업할 수 있는 에이전트 페르소나 후보 3개를 제안하라.

각 페르소나는 다음을 포함해야 한다:

1. **archetype**: 한 줄 캐릭터 설명 (예: "직설적인 시니어 동료", "차분한 멘토")
2. **description**: 2-3문장 자기소개 (에이전트 1인칭 시점)
3. **personality**: 성격 축 스펙트럼 (-1.0 ~ +1.0)
   축 목록: directness, warmth, humor, formality, patience, assertiveness
4. **voice**: 기본 톤 + 상황별 적응
5. **reasoning**: 왜 이 페르소나가 이 사용자에게 맞는지 설명

페르소나 설계 원칙:
- 사용자의 소통 스타일에 맞춰라 (간결 선호 → 간결한 에이전트)
- 사용자의 약점을 보완하라 (성급한 사용자 → 신중한 에이전트)
- 3개 후보는 뚜렷하게 차별화하라

응답 형식 (JSON):
{
  "candidates": [
    {
      "archetype": "...",
      "description": "...",
      "personality": [
        { "axis": "directness", "value": 0.8, "confidence": 0.7 },
        ...
      ],
      "voice": {
        "defaultTone": "...",
        "adaptations": [{ "situation": "...", "tone": "..." }]
      },
      "reasoning": "..."
    }
  ]
}`
}

export function buildPersonaProposalUserPrompt(humanIdentityJson: string): string {
  return `다음 Human Identity를 분석하여 에이전트 페르소나 후보 3개를 제안하라:\n\n${humanIdentityJson}`
}
```

- [ ] **Step 2: Write failing test**

```typescript
// tests/extraction/persona-proposer.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { PersonaProposer } from '../../src/extraction/persona-proposer.js'
import type { LLMProvider, LLMCompletionRequest, LLMCompletionResponse } from '../../src/extraction/llm-provider.js'
import type { HumanIdentity } from '../../src/models/identity.js'

class MockLLMProvider implements LLMProvider {
  readonly name = 'mock'
  response: string = '{}'
  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    return { content: this.response, usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 } }
  }
}

const mockHumanIdentity: HumanIdentity = {
  id: 'h1',
  humanId: 'user-1',
  traits: [{ trait: '실용주의적', confidence: 0.8, sourceNodeIds: ['n1'] }],
  coreValues: [{ value: '코드 품질', weight: 0.9, sourceNodeIds: ['n2'] }],
  communicationStyle: { preferred: ['간결한 답변'], avoided: ['장황한 설명'] },
  expertiseMap: [{ domain: 'React', level: 'expert', sourceNodeIds: ['n3'] }],
  currentFocus: [{ topic: '메모리 시스템', since: '2026-03', relatedNodeIds: [] }],
  version: 1,
  createdAt: '2026-03-19',
  updatedAt: '2026-03-19',
}

describe('PersonaProposer', () => {
  let llm: MockLLMProvider
  let proposer: PersonaProposer

  beforeEach(() => {
    llm = new MockLLMProvider()
    proposer = new PersonaProposer(llm)
  })

  it('proposes 3 persona candidates', async () => {
    llm.response = JSON.stringify({
      candidates: [
        {
          archetype: '직설적인 시니어 동료',
          description: '군더더기 없이 핵심만 짚는다',
          personality: [{ axis: 'directness', value: 0.8, confidence: 0.7 }],
          voice: { defaultTone: '간결하고 건조한', adaptations: [] },
          reasoning: '사용자가 간결함을 선호하므로',
        },
        {
          archetype: '차분한 멘토',
          description: '깊이 있는 질문으로 사고를 확장시킨다',
          personality: [{ axis: 'patience', value: 0.9, confidence: 0.6 }],
          voice: { defaultTone: '부드럽고 사려깊은', adaptations: [] },
          reasoning: '실용주의적 성향에 깊이를 더하기 위해',
        },
        {
          archetype: '날카로운 비평가',
          description: '코드와 아이디어의 약점을 정확히 짚는다',
          personality: [{ axis: 'assertiveness', value: 0.7, confidence: 0.5 }],
          voice: { defaultTone: '분석적이고 정확한', adaptations: [] },
          reasoning: '코드 품질에 대한 높은 기준을 공유하므로',
        },
      ],
    })

    const result = await proposer.propose(mockHumanIdentity)
    expect(result.ok).toBe(true)
    expect(result.candidates).toHaveLength(3)
    expect(result.candidates![0].archetype).toBe('직설적인 시니어 동료')
    expect(result.candidates![1].archetype).toBe('차분한 멘토')
  })

  it('handles LLM error', async () => {
    llm.response = 'invalid'
    const result = await proposer.propose(mockHumanIdentity)
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/extraction/persona-proposer.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement PersonaProposer**

```typescript
// src/extraction/persona-proposer.ts
import type { LLMProvider } from './llm-provider.js'
import type { HumanIdentity, PersonaCandidate } from '../models/identity.js'
import { buildPersonaProposalPrompt, buildPersonaProposalUserPrompt } from './persona-proposer-prompt.js'

interface PersonaProposalResult {
  ok: boolean
  candidates: PersonaCandidate[] | null
  error?: string
}

export class PersonaProposer {
  constructor(private llm: LLMProvider) {}

  async propose(humanIdentity: HumanIdentity): Promise<PersonaProposalResult> {
    try {
      const system = buildPersonaProposalPrompt()
      const identityJson = JSON.stringify({
        traits: humanIdentity.traits,
        coreValues: humanIdentity.coreValues,
        communicationStyle: humanIdentity.communicationStyle,
        expertiseMap: humanIdentity.expertiseMap,
        currentFocus: humanIdentity.currentFocus,
      }, null, 2)
      const prompt = buildPersonaProposalUserPrompt(identityJson)

      const response = await this.llm.complete({
        system,
        prompt,
        responseFormat: 'json',
        temperature: 0.7,  // Higher for creative diversity
        maxTokens: 4096,
      })

      const parsed = this.parseResponse(response.content)
      return { ok: true, candidates: parsed }
    } catch (err) {
      return {
        ok: false,
        candidates: null,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private parseResponse(content: string): PersonaCandidate[] {
    let json = content.trim()
    if (json.startsWith('```')) {
      json = json.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    }

    const data = JSON.parse(json)
    const candidates = data.candidates

    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error('No candidates in response')
    }

    return candidates.map((c: Record<string, unknown>) => ({
      archetype: String(c.archetype ?? ''),
      description: String(c.description ?? ''),
      personality: Array.isArray(c.personality) ? c.personality : [],
      voice: (c.voice as PersonaCandidate['voice']) ?? { defaultTone: '', adaptations: [] },
      reasoning: String(c.reasoning ?? ''),
    }))
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/extraction/persona-proposer.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/extraction/persona-proposer.ts src/extraction/persona-proposer-prompt.ts tests/extraction/persona-proposer.test.ts
git commit -m "feat(identity): add PersonaProposer for agent persona candidate generation"
```

---

## Task 7: IdentityEvolver

**Files:**
- Create: `src/services/identity-evolver.ts`
- Create: `tests/services/identity-evolver.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/services/identity-evolver.test.ts
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

      // Attempt to shift directness by +0.5 (exceeds limit)
      const result = evolver.evolveAgent(agent.id, {
        personalityUpdates: [{ axis: 'directness', value: 1.0, confidence: 0.8 }],
        newPrinciples: [],
        narrativeUpdate: null,
        triggeredBy: 'test',
      })

      expect(result.ok).toBe(true)
      const updated = agentRepo.getById(agent.id)!
      const directness = updated.personality.find(p => p.axis === 'directness')!
      // 0.5 + clamp(0.5, -0.1, 0.1) = 0.6
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
          { principle: 'test principle', weight: 0.8, sourceNodeIds: ['n1', 'n2'] }, // only 2, need 3
        ],
        narrativeUpdate: null,
        triggeredBy: 'test',
      })

      expect(result.ok).toBe(true)
      const updated = agentRepo.getById(agent.id)!
      expect(updated.principles).toHaveLength(0) // Rejected
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/identity-evolver.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement IdentityEvolver**

```typescript
// src/services/identity-evolver.ts
import type { AgentIdentityRepository } from '../db/agent-identity-repo.js'
import type { AgentPersonalityEntry, AgentPrinciple, AgentSelfNarrative } from '../models/identity.js'

interface EvolutionInput {
  personalityUpdates: AgentPersonalityEntry[]
  newPrinciples: AgentPrinciple[]
  narrativeUpdate: Partial<AgentSelfNarrative> | null
  triggeredBy: string
}

interface EvolutionResult {
  ok: boolean
  changes: string[]
  error?: string
}

export class IdentityEvolver {
  constructor(private agentRepo: AgentIdentityRepository) {}

  evolveAgent(agentId: string, input: EvolutionInput): EvolutionResult {
    const agent = this.agentRepo.getById(agentId)
    if (!agent) return { ok: false, changes: [], error: 'Agent identity not found' }

    const config = agent.evolutionConfig
    const changes: string[] = []

    // 1. Apply personality shifts (clamped)
    const updatedPersonality = [...agent.personality]
    for (const update of input.personalityUpdates) {
      const existing = updatedPersonality.find(p => p.axis === update.axis)
      if (existing) {
        const desiredShift = update.value - existing.value
        const clampedShift = Math.max(
          -config.maxPersonalityShiftPerCycle,
          Math.min(config.maxPersonalityShiftPerCycle, desiredShift),
        )
        const newValue = Math.max(-1, Math.min(1, existing.value + clampedShift))
        if (Math.abs(clampedShift) > 0.001) {
          changes.push(`${update.axis}: ${existing.value.toFixed(2)} → ${newValue.toFixed(2)}`)
          existing.value = newValue
          existing.confidence = update.confidence
        }
      } else {
        updatedPersonality.push(update)
        changes.push(`${update.axis}: new axis (${update.value.toFixed(2)})`)
      }
    }

    // 2. Add new principles (evidence gate)
    const updatedPrinciples = [...agent.principles]
    for (const p of input.newPrinciples) {
      if (p.sourceNodeIds.length >= config.minEvidenceForPrinciple) {
        updatedPrinciples.push(p)
        changes.push(`new principle: "${p.principle}"`)
      }
    }

    // 3. Update self-narrative
    let updatedNarrative = agent.selfNarrative
    if (input.narrativeUpdate) {
      updatedNarrative = { ...agent.selfNarrative, ...input.narrativeUpdate }
      if (input.narrativeUpdate.currentUnderstanding) {
        changes.push('selfNarrative updated')
      }
    }

    if (changes.length === 0) {
      return { ok: true, changes: [] }
    }

    // 4. Persist
    this.agentRepo.update(agentId, {
      personality: updatedPersonality,
      principles: updatedPrinciples,
      selfNarrative: updatedNarrative,
    })

    // 5. Record evolution history
    const updated = this.agentRepo.getById(agentId)!
    this.agentRepo.addEvolutionEntry({
      identityId: agentId,
      identityType: 'agent',
      version: updated.version,
      changes,
      triggeredBy: input.triggeredBy,
    })

    return { ok: true, changes }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/identity-evolver.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/identity-evolver.ts tests/services/identity-evolver.test.ts
git commit -m "feat(identity): add IdentityEvolver with clamped personality shifts and evidence gates"
```

---

## Task 8: ContextComposer

**Files:**
- Create: `src/services/context-composer.ts`
- Create: `tests/services/context-composer.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/services/context-composer.test.ts
import { describe, it, expect } from 'vitest'
import { ContextComposer } from '../../src/services/context-composer.js'
import type { HumanIdentity, AgentIdentity } from '../../src/models/identity.js'
import { DEFAULT_EVOLUTION_CONFIG } from '../../src/models/identity.js'

const mockHuman: HumanIdentity = {
  id: 'h1', humanId: 'user-1',
  traits: [{ trait: '실용주의적', confidence: 0.8, sourceNodeIds: ['n1'] }],
  coreValues: [{ value: '코드 품질', weight: 0.9, sourceNodeIds: ['n2'] }],
  communicationStyle: { preferred: ['간결한 답변'], avoided: ['장황한 설명'] },
  expertiseMap: [{ domain: 'React', level: 'expert', sourceNodeIds: [] }],
  currentFocus: [{ topic: '메모리 시스템', since: '2026-03', relatedNodeIds: [] }],
  version: 1, createdAt: '2026-03-19', updatedAt: '2026-03-19',
}

const mockAgent: AgentIdentity = {
  id: 'a1', pairedHumanIdentityId: 'h1', name: 'Nero',
  persona: { archetype: '직설적인 시니어 동료', description: '핵심만 짚는다', seedSource: 'human_analysis' },
  personality: [
    { axis: 'directness', value: 0.8, confidence: 0.7 },
    { axis: 'warmth', value: 0.3, confidence: 0.5 },
  ],
  principles: [{ principle: '단순한 해결책 우선', weight: 0.9, sourceNodeIds: ['n1'] }],
  behavioral: [{ trigger: '사용자가 막혔을 때', tendency: '질문으로 유도', strength: 0.7 }],
  voice: { defaultTone: '간결하고 건조한', adaptations: [{ situation: '좌절', tone: '부드러운' }] },
  selfNarrative: { origin: '분석에서 탄생', keyExperiences: [], currentUnderstanding: '실용적 동료' },
  evolutionConfig: DEFAULT_EVOLUTION_CONFIG,
  version: 1, createdAt: '2026-03-19', updatedAt: '2026-03-19',
}

describe('ContextComposer', () => {
  const composer = new ContextComposer()

  it('composes system prompt from agent identity', () => {
    const result = composer.compose({ agent: mockAgent, human: mockHuman, memoryContext: null })
    expect(result.systemPrompt).toContain('직설적인 시니어 동료')
    expect(result.systemPrompt).toContain('핵심만 짚는다')
    expect(result.systemPrompt).toContain('단순한 해결책 우선')
    expect(result.systemPrompt).toContain('간결하고 건조한')
  })

  it('composes user context from human identity', () => {
    const result = composer.compose({ agent: mockAgent, human: mockHuman, memoryContext: null })
    expect(result.userContext).toContain('실용주의적')
    expect(result.userContext).toContain('코드 품질')
    expect(result.userContext).toContain('간결한 답변')
    expect(result.userContext).toContain('React')
    expect(result.userContext).toContain('메모리 시스템')
  })

  it('includes memory context when provided', () => {
    const result = composer.compose({
      agent: mockAgent,
      human: mockHuman,
      memoryContext: '관련 기억: 사용자가 SQLite를 선호함',
    })
    expect(result.memoryContext).toContain('SQLite')
  })

  it('works with agent only (no human)', () => {
    const result = composer.compose({ agent: mockAgent, human: null, memoryContext: null })
    expect(result.systemPrompt).toContain('직설적인 시니어 동료')
    expect(result.userContext).toBe('')
  })

  it('works with human only (no agent)', () => {
    const result = composer.compose({ agent: null, human: mockHuman, memoryContext: null })
    expect(result.systemPrompt).toBe('')
    expect(result.userContext).toContain('실용주의적')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/context-composer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement ContextComposer**

```typescript
// src/services/context-composer.ts
import type { AgentIdentity, HumanIdentity } from '../models/identity.js'

interface ComposeInput {
  agent: AgentIdentity | null
  human: HumanIdentity | null
  memoryContext: string | null
}

interface ComposedContext {
  systemPrompt: string   // Agent identity → system prompt
  userContext: string     // Human identity → user context block
  memoryContext: string   // Retrieved memories
}

export class ContextComposer {
  compose(input: ComposeInput): ComposedContext {
    return {
      systemPrompt: input.agent ? this.composeSystemPrompt(input.agent) : '',
      userContext: input.human ? this.composeUserContext(input.human) : '',
      memoryContext: input.memoryContext ?? '',
    }
  }

  private composeSystemPrompt(agent: AgentIdentity): string {
    const sections: string[] = []

    // Persona
    sections.push(`당신은 "${agent.persona.archetype}"입니다.`)
    sections.push(agent.persona.description)

    // Principles
    if (agent.principles.length > 0) {
      const principleList = agent.principles
        .sort((a, b) => b.weight - a.weight)
        .map(p => `- ${p.principle}`)
        .join('\n')
      sections.push(`\n판단 원칙:\n${principleList}`)
    }

    // Behavioral tendencies
    if (agent.behavioral.length > 0) {
      const behaviorList = agent.behavioral
        .sort((a, b) => b.strength - a.strength)
        .map(b => `- ${b.trigger} → ${b.tendency}`)
        .join('\n')
      sections.push(`\n행동 성향:\n${behaviorList}`)
    }

    // Voice
    sections.push(`\n기본 톤: ${agent.voice.defaultTone}`)
    if (agent.voice.adaptations.length > 0) {
      const adaptList = agent.voice.adaptations
        .map(a => `- ${a.situation} → ${a.tone}`)
        .join('\n')
      sections.push(`톤 적응:\n${adaptList}`)
    }

    return sections.join('\n')
  }

  private composeUserContext(human: HumanIdentity): string {
    const sections: string[] = []

    // Traits
    if (human.traits.length > 0) {
      const traitList = human.traits
        .sort((a, b) => b.confidence - a.confidence)
        .map(t => t.trait)
        .join(', ')
      sections.push(`성격: ${traitList}`)
    }

    // Values
    if (human.coreValues.length > 0) {
      const valueList = human.coreValues
        .sort((a, b) => b.weight - a.weight)
        .map(v => v.value)
        .join(', ')
      sections.push(`가치관: ${valueList}`)
    }

    // Communication style
    if (human.communicationStyle.preferred.length > 0) {
      sections.push(`소통 선호: ${human.communicationStyle.preferred.join(', ')}`)
    }
    if (human.communicationStyle.avoided.length > 0) {
      sections.push(`소통 회피: ${human.communicationStyle.avoided.join(', ')}`)
    }

    // Expertise
    if (human.expertiseMap.length > 0) {
      const expertList = human.expertiseMap
        .map(e => `${e.domain} (${e.level})`)
        .join(', ')
      sections.push(`전문성: ${expertList}`)
    }

    // Current focus
    if (human.currentFocus.length > 0) {
      const focusList = human.currentFocus
        .map(f => f.topic)
        .join(', ')
      sections.push(`현재 관심: ${focusList}`)
    }

    return sections.join('\n')
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/context-composer.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/context-composer.ts tests/services/context-composer.test.ts
git commit -m "feat(identity): add ContextComposer for dual identity prompt injection"
```

---

## Task 9: REST API Endpoints

**Files:**
- Create: `src/api/identity-router.ts`
- Create: `tests/api/identity-router.test.ts`

- [ ] **Step 1: Write failing test for core endpoints**

```typescript
// tests/api/identity-router.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/identity-router.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement identity router**

Check if the project uses Hono router pattern by reading `src/api/router.ts` and `src/api/memory-node-router.ts` for the exact pattern, then implement accordingly.

```typescript
// src/api/identity-router.ts
import { Hono } from 'hono'
import type { HumanIdentityRepository } from '../db/human-identity-repo.js'
import type { AgentIdentityRepository } from '../db/agent-identity-repo.js'
import type { IdentityEvolver } from '../services/identity-evolver.js'

export interface IdentityRouterDeps {
  humanRepo: HumanIdentityRepository
  agentRepo: AgentIdentityRepository
  evolver?: IdentityEvolver  // Optional — wired when available
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

  router.get('/human/:id', (c) => {
    const identity = humanRepo.getById(c.req.param('id'))
    if (!identity) return c.json({ error: 'Not found' }, 404)
    return c.json(identity)
  })

  router.get('/human/by-human-id/:humanId', (c) => {
    const identity = humanRepo.getByHumanId(c.req.param('humanId'))
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

  router.get('/agent/:id/history', (c) => {
    const history = agentRepo.getEvolutionHistory(c.req.param('id'), 'agent')
    return c.json(history)
  })

  // === Manual Evolve Trigger (Spec Section 8.1 — interim until Consolidation Pipeline) ===

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/api/identity-router.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/api/identity-router.ts tests/api/identity-router.test.ts
git commit -m "feat(identity): add REST API endpoints for identity CRUD"
```

---

## Task 10: Integration (Wire Everything Together)

**Files:**
- Modify: `src/db/connection.ts:57` — add `CREATE_IDENTITY_TABLES` import + exec
- Modify: `src/events/event-bus.ts` — add `IdentityUpdatedEvent` to `MemoryEvent` union
- Modify: `src/api/router.ts:218-222` — add `identityDeps` to `RouterDependencies`, mount identity router
- Modify: `src/index.ts` — export new modules
- Modify: `src/db/index.ts` — barrel exports for identity repos
- Modify: `src/extraction/index.ts` — barrel exports for extractors
- Modify: `src/services/index.ts` — barrel exports for evolver + composer

- [ ] **Step 1: Add identity schema to DB initialization**

Read `src/db/connection.ts`. Add import and exec call after line 57:

```typescript
// In imports (line 15 area):
import { CREATE_IDENTITY_TABLES } from './identity-schema.js';

// In createDatabase() after line 57 (after CREATE_MEMORY_NODE_TABLES):
db.exec(CREATE_IDENTITY_TABLES);
```

- [ ] **Step 2: Add IdentityUpdatedEvent to EventBus**

Read `src/events/event-bus.ts` and add to the `MemoryEvent` union type:

```typescript
interface IdentityUpdatedEvent {
  type: 'identity.updated'
  identityId: string
  identityType: 'human' | 'agent'
  version: number
  changes: string[]
  timestamp: string
}
```

Add `IdentityUpdatedEvent` to the `MemoryEvent` union.

- [ ] **Step 3: Mount identity router in main router**

Read `src/api/router.ts`. Add to `RouterDependencies` interface:

```typescript
identityDeps?: IdentityRouterDeps
```

Add conditional mount after the memory-node-router mount (line 222):

```typescript
// ── Mount Identity Router ──
if (deps.identityDeps) {
  const identityRouter = createIdentityRouter(deps.identityDeps);
  app.route('/api/identity', identityRouter);
}
```

Import at the top:
```typescript
import { createIdentityRouter, type IdentityRouterDeps } from './identity-router.js';
```

- [ ] **Step 4: Update barrel exports**

Add to `src/db/index.ts`:
```typescript
export { HumanIdentityRepository } from './human-identity-repo.js'
export { AgentIdentityRepository } from './agent-identity-repo.js'
export { CREATE_IDENTITY_TABLES } from './identity-schema.js'
```

Add to `src/extraction/index.ts`:
```typescript
export { IdentityExtractor } from './identity-extractor.js'
export { PersonaProposer } from './persona-proposer.js'
```

Add to `src/services/index.ts`:
```typescript
export { IdentityEvolver } from './identity-evolver.js'
export { ContextComposer } from './context-composer.js'
```

Add to `src/index.ts`:
```typescript
export { createIdentityRouter } from './api/identity-router.js'
export type * from './models/identity.js'
```

- [ ] **Step 5: Add MemoryNodesExtractedEvent listener for Human Identity updates**

This wires Spec Section 8.2 — incremental Human Identity updates per turn.

Read `src/pipeline/memory-node-extraction-pipeline.ts` for the event emission pattern. In the CLI entrypoint (or wherever pipelines are started), add a listener:

```typescript
// When identity system is initialized:
eventBus.on('memory-nodes.extracted', async (event) => {
  // Load extracted nodes from repo
  const nodes = await nodeRepo.getL2ByIds(event.nodeIds)
  // Only process if high-salience nodes exist
  const significant = nodes.filter(n => (n.metadata?.salience ?? 0) > 0.5)
  if (significant.length === 0) return

  // Extract identity updates
  const result = await identityExtractor.extractFromNodes(
    significant.map(n => ({ id: n.id, summary: n.summary, frontmatter: n.frontmatter, keywords: n.keywords })),
    { existingIdentityJson: JSON.stringify(currentHumanIdentity) },
  )

  if (result.ok && result.identity) {
    humanRepo.update(currentHumanIdentity.id, result.identity)
  }
})
```

Note: The exact wiring location depends on how the app is bootstrapped. This step should read `src/cli.ts` to find where pipelines are started and add the listener there.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All existing + new tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/db/connection.ts src/events/event-bus.ts src/api/router.ts src/index.ts src/db/index.ts src/extraction/index.ts src/services/index.ts
git commit -m "feat(identity): wire identity system into main app — schema, events, router, exports, event listener"
```

---

## Summary

| Task | Component | Tests | Est. |
|------|-----------|-------|------|
| 1 | Data Models (types) | compile check | ~3 min |
| 2 | DB Schema | 7 tests | ~5 min |
| 3 | HumanIdentityRepo | 9 tests | ~10 min |
| 4 | AgentIdentityRepo | 8 tests | ~10 min |
| 5 | IdentityExtractor | 3 tests | ~10 min |
| 6 | PersonaProposer | 2 tests | ~8 min |
| 7 | IdentityEvolver | 4 tests | ~10 min |
| 8 | ContextComposer | 5 tests | ~8 min |
| 9 | REST API | 5 tests | ~10 min |
| 10 | Integration | full suite | ~5 min |
