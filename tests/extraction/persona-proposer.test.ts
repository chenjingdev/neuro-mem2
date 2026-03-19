import { describe, it, expect, beforeEach } from 'vitest'
import { PersonaProposer } from '../../src/extraction/persona-proposer.js'
import { MockLLMProvider } from '../../src/extraction/llm-provider.js'
import type { HumanIdentity } from '../../src/models/identity.js'

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
    llm.addResponse(JSON.stringify({
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
    }))

    const result = await proposer.propose(mockHumanIdentity)
    expect(result.ok).toBe(true)
    expect(result.candidates).toHaveLength(3)
    expect(result.candidates![0].archetype).toBe('직설적인 시니어 동료')
    expect(result.candidates![1].archetype).toBe('차분한 멘토')
  })

  it('handles LLM error', async () => {
    llm.addResponse('invalid')
    const result = await proposer.propose(mockHumanIdentity)
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.candidates).toBeNull()
  })

  it('passes correct request parameters to LLM', async () => {
    llm.addResponse(JSON.stringify({
      candidates: [
        {
          archetype: 'test',
          description: 'test',
          personality: [],
          voice: { defaultTone: 'test', adaptations: [] },
          reasoning: 'test',
        },
      ],
    }))

    await proposer.propose(mockHumanIdentity)
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].responseFormat).toBe('json')
    expect(llm.calls[0].temperature).toBe(0.7)
    expect(llm.calls[0].maxTokens).toBe(4096)
  })

  it('handles markdown-wrapped JSON response', async () => {
    llm.addResponse('```json\n' + JSON.stringify({
      candidates: [
        {
          archetype: 'wrapped',
          description: 'test',
          personality: [],
          voice: { defaultTone: 'test', adaptations: [] },
          reasoning: 'test',
        },
      ],
    }) + '\n```')

    const result = await proposer.propose(mockHumanIdentity)
    expect(result.ok).toBe(true)
    expect(result.candidates![0].archetype).toBe('wrapped')
  })
})
