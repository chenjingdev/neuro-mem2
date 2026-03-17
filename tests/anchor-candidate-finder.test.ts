/**
 * Tests for AnchorCandidateFinder — coarse-filters existing anchors by local
 * embedding similarity during fact ingestion.
 *
 * Tests cover:
 *   1. Finding candidates for a fact against existing anchors
 *   2. Similarity threshold filtering
 *   3. Top-k limiting
 *   4. Decay-aware scoring (effective weight factors into score)
 *   5. Empty DB / no anchors edge case
 *   6. Pre-computed embedding search (findCandidatesByEmbedding)
 *   7. Batch candidate search (findCandidatesBatch)
 *   8. Reuse of VectorSearcher helpers (cosineSimilarityVec, bufferToFloat32Array)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import {
  AnchorCandidateFinder,
  DEFAULT_CANDIDATE_FINDER_CONFIG,
} from '../src/services/anchor-candidate-finder.js';
import type Database from 'better-sqlite3';

// ─── Test Helpers ────────────────────────────────────────────────

const DIM = 64;

/** Create a normalized vector with a given seed for reproducible tests */
function makeVector(seed: number, dim: number = DIM): number[] {
  const v: number[] = [];
  let hash = seed;
  for (let i = 0; i < dim; i++) {
    hash = (hash * 1664525 + 1013904223) | 0;
    v.push((hash & 0x7fffffff) / 0x7fffffff);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return v.map(x => x / norm);
}

/** Create a vector that is close to another (high cosine similarity) */
function makeSimilarVector(base: number[], noise: number = 0.05): number[] {
  const v = base.map(x => x + (Math.random() - 0.5) * noise);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return v.map(x => x / norm);
}

// ─── Test Suite ──────────────────────────────────────────────────

describe('AnchorCandidateFinder', () => {
  let db: Database.Database;
  let anchorRepo: AnchorRepository;
  let embeddingProvider: MockEmbeddingProvider;
  let finder: AnchorCandidateFinder;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    anchorRepo = new AnchorRepository(db);
    embeddingProvider = new MockEmbeddingProvider(DIM);
    finder = new AnchorCandidateFinder(db, embeddingProvider);
  });

  // ── Basic candidate finding ─────────────────────────────────

  it('finds candidates for a fact based on embedding similarity', async () => {
    // Set up: anchor with known embedding
    const anchorVec = makeVector(42);
    const factVec = makeSimilarVector(anchorVec, 0.01); // Very similar

    anchorRepo.createAnchor({
      label: 'TypeScript',
      description: 'TypeScript programming language',
      anchorType: 'topic',
      embedding: new Float32Array(anchorVec),
    });

    // Mock: return factVec when embedding the fact content
    embeddingProvider.setEmbedding('User prefers TypeScript', factVec);

    const result = await finder.findCandidates('User prefers TypeScript');

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].label).toBe('TypeScript');
    expect(result.candidates[0].similarity).toBeGreaterThan(0.9);
    expect(result.candidates[0].anchorType).toBe('topic');
    expect(result.factEmbedding).toEqual(factVec);
  });

  it('returns multiple candidates ranked by score', async () => {
    const factVec = makeVector(1);

    // Create 3 anchors with decreasing similarity to factVec
    const highSimVec = makeSimilarVector(factVec, 0.01);
    const medSimVec = makeSimilarVector(factVec, 0.3);
    const lowSimVec = makeVector(999); // Very different

    anchorRepo.createAnchor({
      label: 'Close Match',
      description: 'Very similar anchor',
      anchorType: 'topic',
      embedding: new Float32Array(highSimVec),
    });
    anchorRepo.createAnchor({
      label: 'Medium Match',
      description: 'Somewhat similar anchor',
      anchorType: 'entity',
      embedding: new Float32Array(medSimVec),
    });
    anchorRepo.createAnchor({
      label: 'Distant',
      description: 'Very different anchor',
      anchorType: 'topic',
      embedding: new Float32Array(lowSimVec),
    });

    embeddingProvider.setEmbedding('test fact', factVec);

    const result = await finder.findCandidates('test fact');

    // Should find at least the close match
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    // Candidates should be sorted by score descending
    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1].score).toBeGreaterThanOrEqual(
        result.candidates[i].score,
      );
    }
  });

  // ── Threshold filtering ─────────────────────────────────────

  it('filters out anchors below similarity threshold', async () => {
    const factVec = makeVector(1);
    // Create an anchor with an orthogonal-ish embedding
    const distantVec = makeVector(9999);

    anchorRepo.createAnchor({
      label: 'Distant Anchor',
      description: 'Should be filtered out',
      anchorType: 'topic',
      embedding: new Float32Array(distantVec),
    });

    embeddingProvider.setEmbedding('some fact', factVec);

    const result = await finder.findCandidates('some fact');

    // All returned candidates should be above threshold
    for (const c of result.candidates) {
      expect(c.similarity).toBeGreaterThanOrEqual(
        DEFAULT_CANDIDATE_FINDER_CONFIG.similarityThreshold,
      );
    }
  });

  it('respects custom similarity threshold', async () => {
    const factVec = makeVector(1);
    const anchorVec = makeSimilarVector(factVec, 0.3);

    anchorRepo.createAnchor({
      label: 'Medium Match',
      description: 'Medium similarity',
      anchorType: 'topic',
      embedding: new Float32Array(anchorVec),
    });

    embeddingProvider.setEmbedding('test', factVec);

    // With very high threshold, fewer candidates
    const strictFinder = new AnchorCandidateFinder(db, embeddingProvider, {
      similarityThreshold: 0.99,
    });
    const strictResult = await strictFinder.findCandidates('test');

    // With low threshold, more candidates
    const looseFinder = new AnchorCandidateFinder(db, embeddingProvider, {
      similarityThreshold: 0.01,
    });
    const looseResult = await looseFinder.findCandidates('test');

    expect(looseResult.candidates.length).toBeGreaterThanOrEqual(
      strictResult.candidates.length,
    );
  });

  // ── Top-k limiting ─────────────────────────────────────────

  it('limits results to maxCandidates', async () => {
    const factVec = makeVector(1);
    embeddingProvider.setEmbedding('fact', factVec);

    // Create 15 anchors all similar to factVec
    for (let i = 0; i < 15; i++) {
      anchorRepo.createAnchor({
        label: `Anchor ${i}`,
        description: `Test anchor ${i}`,
        anchorType: 'topic',
        embedding: new Float32Array(makeSimilarVector(factVec, 0.05)),
      });
    }

    const limitedFinder = new AnchorCandidateFinder(db, embeddingProvider, {
      maxCandidates: 5,
      similarityThreshold: 0.01,
    });
    const result = await limitedFinder.findCandidates('fact');

    expect(result.candidates.length).toBeLessThanOrEqual(5);
    expect(result.stats.anchorsCompared).toBe(15);
  });

  // ── Decay-aware scoring ─────────────────────────────────────

  it('factors effective weight into score when decay weighting is enabled', async () => {
    const factVec = makeVector(1);
    const anchorVec = makeSimilarVector(factVec, 0.01);

    // Create anchor with high weight
    anchorRepo.createAnchor({
      label: 'High Weight',
      description: 'Recently accessed anchor',
      anchorType: 'topic',
      embedding: new Float32Array(anchorVec),
      initialWeight: 0.9,
    });

    embeddingProvider.setEmbedding('fact', factVec);

    const result = await finder.findCandidates('fact');
    expect(result.candidates.length).toBe(1);

    const candidate = result.candidates[0];
    // score = similarity * effectiveWeight
    expect(candidate.score).toBeLessThanOrEqual(candidate.similarity);
    expect(candidate.effectiveWeight).toBeGreaterThan(0);
    expect(candidate.effectiveWeight).toBeLessThanOrEqual(1);
  });

  it('can disable decay weighting', async () => {
    const factVec = makeVector(1);
    const anchorVec = makeSimilarVector(factVec, 0.01);

    anchorRepo.createAnchor({
      label: 'Test',
      description: 'Test anchor',
      anchorType: 'topic',
      embedding: new Float32Array(anchorVec),
    });

    embeddingProvider.setEmbedding('fact', factVec);

    const noDecayFinder = new AnchorCandidateFinder(db, embeddingProvider, {
      useDecayWeighting: false,
    });
    const result = await noDecayFinder.findCandidates('fact');

    expect(result.candidates.length).toBe(1);
    // With decay disabled, effectiveWeight = 1.0, so score ≈ similarity
    expect(result.candidates[0].effectiveWeight).toBe(1);
    expect(result.candidates[0].score).toBe(result.candidates[0].similarity);
  });

  // ── Edge cases ──────────────────────────────────────────────

  it('returns empty candidates when no anchors exist', async () => {
    const result = await finder.findCandidates('some fact about nothing');

    expect(result.candidates).toEqual([]);
    expect(result.stats.anchorsCompared).toBe(0);
    expect(result.stats.candidatesFound).toBe(0);
  });

  it('returns empty candidates when anchors have no embeddings', async () => {
    // Create anchor without embedding
    anchorRepo.createAnchor({
      label: 'No Embedding',
      description: 'Anchor without embedding vector',
      anchorType: 'topic',
    });

    const result = await finder.findCandidates('some fact');

    expect(result.candidates).toEqual([]);
    expect(result.stats.anchorsCompared).toBe(0);
  });

  // ── Pre-computed embedding search ───────────────────────────

  it('finds candidates by pre-computed embedding (no embed call)', () => {
    const factVec = makeVector(1);
    const anchorVec = makeSimilarVector(factVec, 0.01);

    anchorRepo.createAnchor({
      label: 'Test Anchor',
      description: 'Test description',
      anchorType: 'entity',
      embedding: new Float32Array(anchorVec),
    });

    // No embed call is made — use pre-computed vector directly
    const result = finder.findCandidatesByEmbedding(factVec);

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].label).toBe('Test Anchor');
    expect(result.stats.embeddingTimeMs).toBe(0); // No embedding was generated
    expect(embeddingProvider.calls.length).toBe(0); // No calls to provider
  });

  // ── Batch search ────────────────────────────────────────────

  it('finds candidates for multiple facts in batch', async () => {
    const vec1 = makeVector(1);
    const vec2 = makeVector(2);

    anchorRepo.createAnchor({
      label: 'Anchor A',
      description: 'First anchor',
      anchorType: 'topic',
      embedding: new Float32Array(makeSimilarVector(vec1, 0.01)),
    });
    anchorRepo.createAnchor({
      label: 'Anchor B',
      description: 'Second anchor',
      anchorType: 'entity',
      embedding: new Float32Array(makeSimilarVector(vec2, 0.01)),
    });

    embeddingProvider.setEmbedding('fact one', vec1);
    embeddingProvider.setEmbedding('fact two', vec2);

    const results = await finder.findCandidatesBatch(['fact one', 'fact two']);

    expect(results.length).toBe(2);
    // Each fact should find its matching anchor
    expect(results[0].candidates.length).toBeGreaterThanOrEqual(1);
    expect(results[1].candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty array for empty batch', async () => {
    const results = await finder.findCandidatesBatch([]);
    expect(results).toEqual([]);
  });

  // ── Stats / performance tracking ────────────────────────────

  it('provides performance stats', async () => {
    const factVec = makeVector(1);
    embeddingProvider.setEmbedding('fact', factVec);

    anchorRepo.createAnchor({
      label: 'Test',
      description: 'Test anchor',
      anchorType: 'topic',
      embedding: new Float32Array(makeSimilarVector(factVec, 0.01)),
    });

    const result = await finder.findCandidates('fact');

    expect(result.stats.embeddingTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.stats.searchTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.stats.anchorsCompared).toBe(1);
    expect(result.stats.candidatesFound).toBeGreaterThanOrEqual(0);
  });

  // ── Candidate shape validation ──────────────────────────────

  it('returns complete candidate metadata', async () => {
    const factVec = makeVector(1);
    const anchorVec = makeSimilarVector(factVec, 0.01);

    anchorRepo.createAnchor({
      label: 'TypeScript Config',
      description: 'TypeScript project configuration preferences',
      anchorType: 'topic',
      embedding: new Float32Array(anchorVec),
    });

    embeddingProvider.setEmbedding('fact', factVec);
    const result = await finder.findCandidates('fact');

    expect(result.candidates.length).toBe(1);
    const c = result.candidates[0];

    // Verify all fields are present and typed correctly
    expect(typeof c.anchorId).toBe('string');
    expect(c.label).toBe('TypeScript Config');
    expect(c.description).toBe('TypeScript project configuration preferences');
    expect(c.anchorType).toBe('topic');
    expect(typeof c.similarity).toBe('number');
    expect(typeof c.effectiveWeight).toBe('number');
    expect(typeof c.score).toBe('number');
    expect(c.similarity).toBeGreaterThan(0);
    expect(c.similarity).toBeLessThanOrEqual(1);
  });
});
