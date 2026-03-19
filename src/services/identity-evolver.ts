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
