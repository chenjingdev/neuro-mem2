import { describe, it, expect, beforeEach } from 'vitest'
import { IdentityExtractor } from '../../src/extraction/identity-extractor.js'
import { MockLLMProvider } from '../../src/extraction/llm-provider.js'

describe('IdentityExtractor', () => {
  let llm: MockLLMProvider
  let extractor: IdentityExtractor

  beforeEach(() => {
    llm = new MockLLMProvider()
    extractor = new IdentityExtractor(llm)
  })

  it('extracts identity from memory nodes', async () => {
    llm.addResponse(JSON.stringify({
      traits: [{ trait: '실용주의적', confidence: 0.8, sourceNodeIds: ['n1'] }],
      coreValues: [{ value: '코드 품질', weight: 0.9, sourceNodeIds: ['n2'] }],
      communicationStyle: { preferred: ['간결한 답변'], avoided: [] },
      expertiseMap: [{ domain: 'TypeScript', level: 'advanced', sourceNodeIds: ['n3'] }],
      currentFocus: [{ topic: '메모리 시스템', relatedNodeIds: ['n1', 'n2'] }],
    }))

    const result = await extractor.extractFromNodes([
      { id: 'n1', summary: 'React보다 실용적인 도구를 선호', frontmatter: 'preference', keywords: 'react pragmatic' },
      { id: 'n2', summary: '코드 품질에 대한 강한 의견', frontmatter: 'value', keywords: 'code quality' },
      { id: 'n3', summary: 'TypeScript 고급 패턴 사용', frontmatter: 'skill', keywords: 'typescript advanced' },
    ])

    expect(result.ok).toBe(true)
    expect(result.identity!.traits).toHaveLength(1)
    expect(result.identity!.traits![0].trait).toBe('실용주의적')
    expect(result.identity!.coreValues![0].value).toBe('코드 품질')
  })

  it('returns null identity for empty nodes', async () => {
    const result = await extractor.extractFromNodes([])
    expect(result.ok).toBe(true)
    expect(result.identity).toBeNull()
  })

  it('handles LLM error gracefully', async () => {
    llm.addResponse('not valid json at all')
    const result = await extractor.extractFromNodes([
      { id: 'n1', summary: 'test', frontmatter: 'test', keywords: 'test' },
    ])
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('passes existing identity for incremental update', async () => {
    llm.addResponse(JSON.stringify({
      traits: [{ trait: '실용주의적', confidence: 0.9, sourceNodeIds: ['n1', 'n4'] }],
      coreValues: [],
      communicationStyle: { preferred: [], avoided: [] },
      expertiseMap: [],
      currentFocus: [],
    }))

    await extractor.extractFromNodes(
      [{ id: 'n4', summary: 'new info', frontmatter: 'info', keywords: 'new' }],
      { existingIdentityJson: '{"traits": [{"trait": "실용주의적"}]}' },
    )

    expect(llm.calls[0].system).toContain('현재 Human Identity')
  })

  it('sends correct LLM request parameters', async () => {
    llm.addResponse(JSON.stringify({
      traits: [],
      coreValues: [],
      communicationStyle: { preferred: [], avoided: [] },
      expertiseMap: [],
      currentFocus: [],
    }))

    await extractor.extractFromNodes([
      { id: 'n1', summary: 'test', frontmatter: 'test', keywords: 'test' },
    ])

    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].responseFormat).toBe('json')
    expect(llm.calls[0].temperature).toBe(0.1)
    expect(llm.calls[0].maxTokens).toBe(4096)
  })
})
