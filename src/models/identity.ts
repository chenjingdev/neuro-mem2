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
