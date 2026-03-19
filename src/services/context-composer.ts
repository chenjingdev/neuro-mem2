import type { AgentIdentity, HumanIdentity } from '../models/identity.js'

interface ComposeInput {
  agent: AgentIdentity | null
  human: HumanIdentity | null
  memoryContext: string | null
}

interface ComposedContext {
  systemPrompt: string
  userContext: string
  memoryContext: string
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

    sections.push(`당신은 "${agent.persona.archetype}"입니다.`)
    sections.push(agent.persona.description)

    if (agent.principles.length > 0) {
      const principleList = agent.principles
        .sort((a, b) => b.weight - a.weight)
        .map(p => `- ${p.principle}`)
        .join('\n')
      sections.push(`\n판단 원칙:\n${principleList}`)
    }

    if (agent.behavioral.length > 0) {
      const behaviorList = agent.behavioral
        .sort((a, b) => b.strength - a.strength)
        .map(b => `- ${b.trigger} → ${b.tendency}`)
        .join('\n')
      sections.push(`\n행동 성향:\n${behaviorList}`)
    }

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

    if (human.traits.length > 0) {
      const traitList = human.traits
        .sort((a, b) => b.confidence - a.confidence)
        .map(t => t.trait)
        .join(', ')
      sections.push(`성격: ${traitList}`)
    }

    if (human.coreValues.length > 0) {
      const valueList = human.coreValues
        .sort((a, b) => b.weight - a.weight)
        .map(v => v.value)
        .join(', ')
      sections.push(`가치관: ${valueList}`)
    }

    if (human.communicationStyle.preferred.length > 0) {
      sections.push(`소통 선호: ${human.communicationStyle.preferred.join(', ')}`)
    }
    if (human.communicationStyle.avoided.length > 0) {
      sections.push(`소통 회피: ${human.communicationStyle.avoided.join(', ')}`)
    }

    if (human.expertiseMap.length > 0) {
      const expertList = human.expertiseMap
        .map(e => `${e.domain} (${e.level})`)
        .join(', ')
      sections.push(`전문성: ${expertList}`)
    }

    if (human.currentFocus.length > 0) {
      const focusList = human.currentFocus
        .map(f => f.topic)
        .join(', ')
      sections.push(`현재 관심: ${focusList}`)
    }

    return sections.join('\n')
  }
}
