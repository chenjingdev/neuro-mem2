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
        temperature: 0.7,
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
