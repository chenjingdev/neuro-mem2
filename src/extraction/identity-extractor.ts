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
