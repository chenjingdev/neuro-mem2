/**
 * Fact Ingestion Pipeline — orchestrates the sequential steps of:
 *   1. LLM frontmatter generation (Level 0: one-line label for quick scanning)
 *   2. LLM summary generation (Level 1: 1–2 sentence summary)
 *   3. DB persistence via FactRepository
 *   4. (Optional) Anchor linking: coarse filter + LLM-driven anchor connection/creation
 *
 * This service sits between fact extraction and storage.  The existing
 * TurnExtractionPipeline produces raw CreateFactInput objects; this pipeline
 * enriches them with LLM-generated frontmatter & summary before persisting.
 *
 * When anchor linking is enabled (anchorCandidateFinder + anchorLinker are
 * provided), the pipeline also runs brain-like associative anchor linking
 * after fact persistence:
 *   - AnchorCandidateFinder: coarse-filters existing anchors by embedding similarity
 *   - AnchorLinker: LLM decides which anchors to connect / create
 *
 * Design decisions:
 * - Sequential generation (frontmatter → summary) so each step can inform the next
 * - Graceful degradation: if LLM generation fails, facts are still saved without
 *   frontmatter / summary rather than losing the entire fact
 * - Anchor linking is fire-and-forget: if it fails, facts are still saved
 * - Batch-friendly: accepts an array of inputs for transactional saves
 * - Fully local: uses the same pluggable LLMProvider interface already in the codebase
 */

import type { LLMProvider } from '../extraction/llm-provider.js';
import type { FactRepository } from '../db/fact-repo.js';
import type { CreateFactInput, Fact } from '../models/fact.js';
import type { AnchorCandidateFinder } from './anchor-candidate-finder.js';
import type { AnchorLinker, AnchorLinkResult } from './anchor-linker.js';

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

/**
 * Build a prompt that asks the LLM for a one-line frontmatter label (Level 0).
 */
function buildFrontmatterPrompt(factContent: string): { system: string; prompt: string } {
  return {
    system: [
      'You are a concise labeler for a memory system.',
      'Given a factual statement, produce a single short label (≤ 12 words) that',
      'captures the essence of the fact for quick visual scanning.',
      'Respond with ONLY the label text — no quotes, no explanation.',
    ].join(' '),
    prompt: factContent,
  };
}

/**
 * Build a prompt that asks the LLM for a 1–2 sentence summary (Level 1).
 */
function buildSummaryPrompt(factContent: string, frontmatter?: string): { system: string; prompt: string } {
  const contextHint = frontmatter
    ? `\nLabel: ${frontmatter}`
    : '';

  return {
    system: [
      'You are a summarizer for a memory system.',
      'Given a factual statement, produce a concise summary of 1–2 sentences',
      'that retains the key information while being shorter than the original.',
      'Respond with ONLY the summary text — no quotes, no explanation.',
    ].join(' '),
    prompt: `${factContent}${contextHint}`,
  };
}

// ---------------------------------------------------------------------------
// Pipeline options
// ---------------------------------------------------------------------------

export interface FactIngestionPipelineOptions {
  /**
   * Whether to generate frontmatter (Level 0) via LLM.
   * Default: true
   */
  generateFrontmatter?: boolean;

  /**
   * Whether to generate summary (Level 1) via LLM.
   * Default: true
   */
  generateSummary?: boolean;

  /**
   * LLM temperature for generation.
   * Default: 0.3 (deterministic-ish)
   */
  temperature?: number;

  /**
   * Max tokens for each LLM generation call.
   * Default: 100
   */
  maxTokens?: number;

  /**
   * Whether to run anchor linking (coarse filter + LLM decision) after fact persistence.
   * Requires anchorCandidateFinder and anchorLinker to be provided in deps.
   * Default: true (but only executes if services are available)
   */
  enableAnchorLinking?: boolean;
}

const DEFAULT_OPTIONS: Required<FactIngestionPipelineOptions> = {
  generateFrontmatter: true,
  generateSummary: true,
  temperature: 0.3,
  maxTokens: 100,
  enableAnchorLinking: true,
};

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

export interface FactIngestionResult {
  /** Successfully persisted facts (with frontmatter/summary populated) */
  facts: Fact[];
  /** Per-fact warnings (e.g. LLM generation failed for frontmatter/summary) */
  warnings: string[];
  /** Anchor linking results per fact (only if anchor linking is enabled and services provided) */
  anchorLinkResults?: AnchorLinkResult[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FactIngestionPipeline {
  private readonly opts: Required<FactIngestionPipelineOptions>;
  private readonly anchorCandidateFinder?: AnchorCandidateFinder;
  private readonly anchorLinker?: AnchorLinker;

  constructor(
    private readonly llmProvider: LLMProvider,
    private readonly factRepo: FactRepository,
    options: FactIngestionPipelineOptions = {},
    deps?: {
      anchorCandidateFinder?: AnchorCandidateFinder;
      anchorLinker?: AnchorLinker;
    },
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.anchorCandidateFinder = deps?.anchorCandidateFinder;
    this.anchorLinker = deps?.anchorLinker;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Enrich a single CreateFactInput with LLM-generated frontmatter & summary,
   * then persist it.
   */
  async ingestOne(input: CreateFactInput): Promise<FactIngestionResult> {
    return this.ingestMany([input]);
  }

  /**
   * Enrich and persist a batch of facts.  Each fact goes through:
   *   1. generateFrontmatter (if enabled)
   *   2. generateSummary (if enabled)
   *   3. DB insert (all in one transaction via factRepo.createMany)
   *   4. Anchor linking (if enabled and services provided)
   */
  async ingestMany(inputs: CreateFactInput[]): Promise<FactIngestionResult> {
    if (inputs.length === 0) {
      return { facts: [], warnings: [] };
    }

    const warnings: string[] = [];
    const enriched: CreateFactInput[] = [];

    for (const input of inputs) {
      const enrichedInput = { ...input };

      // Step 1: generate frontmatter (Level 0)
      if (this.opts.generateFrontmatter && !input.frontmatter) {
        try {
          const fm = await this.generateFrontmatter(input.content);
          enrichedInput.frontmatter = fm;
        } catch (err) {
          warnings.push(
            `Frontmatter generation failed for fact "${input.content.slice(0, 50)}…": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // Step 2: generate summary (Level 1)
      if (this.opts.generateSummary && !input.summary) {
        try {
          const summary = await this.generateSummary(input.content, enrichedInput.frontmatter);
          enrichedInput.summary = summary;
        } catch (err) {
          warnings.push(
            `Summary generation failed for fact "${input.content.slice(0, 50)}…": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      enriched.push(enrichedInput);
    }

    // Step 3: persist
    const facts = this.factRepo.createMany(enriched);

    // Step 4: Anchor linking (optional, fire-and-forget on failure)
    let anchorLinkResults: AnchorLinkResult[] | undefined;
    if (
      this.opts.enableAnchorLinking &&
      this.anchorCandidateFinder &&
      this.anchorLinker
    ) {
      anchorLinkResults = [];
      for (const fact of facts) {
        try {
          // 4a: Coarse filter — find candidate anchors by embedding similarity
          const candidateResult =
            await this.anchorCandidateFinder.findCandidates(fact.content);

          // 4b: LLM decision — connect to existing / create new anchors
          const linkResult = await this.anchorLinker.linkFact(
            fact,
            candidateResult.candidates,
            candidateResult.factEmbedding,
          );

          anchorLinkResults.push(linkResult);
        } catch (err) {
          warnings.push(
            `Anchor linking failed for fact "${fact.content.slice(0, 50)}…": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    return { facts, warnings, anchorLinkResults };
  }

  // -----------------------------------------------------------------------
  // LLM generation helpers
  // -----------------------------------------------------------------------

  /**
   * Ask the LLM for a one-line frontmatter label (Level 0).
   */
  private async generateFrontmatter(factContent: string): Promise<string> {
    const { system, prompt } = buildFrontmatterPrompt(factContent);
    const response = await this.llmProvider.complete({
      system,
      prompt,
      temperature: this.opts.temperature,
      maxTokens: this.opts.maxTokens,
      responseFormat: 'text',
    });
    return response.content.trim();
  }

  /**
   * Ask the LLM for a 1–2 sentence summary (Level 1).
   */
  private async generateSummary(factContent: string, frontmatter?: string): Promise<string> {
    const { system, prompt } = buildSummaryPrompt(factContent, frontmatter);
    const response = await this.llmProvider.complete({
      system,
      prompt,
      temperature: this.opts.temperature,
      maxTokens: this.opts.maxTokens,
      responseFormat: 'text',
    });
    return response.content.trim();
  }
}
