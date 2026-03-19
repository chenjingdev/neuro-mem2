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
