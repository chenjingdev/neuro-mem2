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
