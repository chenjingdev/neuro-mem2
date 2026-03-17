/**
 * Tests for LocalEmbeddingProvider — local all-MiniLM-L6-v2 embeddings.
 *
 * These tests require the ONNX model to be downloaded on first run (~80 MB).
 * Subsequent runs use the cached model.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  LocalEmbeddingProvider,
  resetLocalEmbeddingPipeline,
} from '../src/retrieval/local-embedding-provider.js';

// Helper: cosine similarity between two vectors
function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describe('LocalEmbeddingProvider', () => {
  let provider: LocalEmbeddingProvider;

  beforeAll(async () => {
    provider = new LocalEmbeddingProvider();
    // Warm up model — first call downloads/loads ONNX weights
    await provider.warmup();
  }, 120_000); // 2 min timeout for model download

  it('has correct metadata', () => {
    expect(provider.name).toBe('local-minilm');
    expect(provider.dimensions).toBe(384);
  });

  it('produces a 384-dimensional embedding', async () => {
    const res = await provider.embed({ text: 'Hello world' });
    expect(res.dimensions).toBe(384);
    expect(res.embedding).toHaveLength(384);
  });

  it('returns L2-normalized vectors (unit length)', async () => {
    const res = await provider.embed({ text: 'The quick brown fox jumps over the lazy dog' });
    const norm = Math.sqrt(res.embedding.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 2);
  });

  it('is deterministic — same text produces same embedding', async () => {
    const a = await provider.embed({ text: 'deterministic test' });
    const b = await provider.embed({ text: 'deterministic test' });
    expect(a.embedding).toEqual(b.embedding);
  });

  it('semantically similar texts have high cosine similarity', async () => {
    const [a, b] = await Promise.all([
      provider.embed({ text: 'The cat sat on the mat' }),
      provider.embed({ text: 'A kitten is sitting on a rug' }),
    ]);
    const sim = cosine(a.embedding, b.embedding);
    // Similar sentences should have similarity > 0.5
    expect(sim).toBeGreaterThan(0.5);
  });

  it('dissimilar texts have low cosine similarity', async () => {
    const [a, b] = await Promise.all([
      provider.embed({ text: 'Quantum computing uses qubits for parallel processing' }),
      provider.embed({ text: 'I baked a chocolate cake yesterday' }),
    ]);
    const sim = cosine(a.embedding, b.embedding);
    // Dissimilar sentences should have low similarity
    expect(sim).toBeLessThan(0.4);
  });

  it('embedBatch processes multiple texts', async () => {
    const results = await provider.embedBatch([
      'First sentence',
      'Second sentence',
      'Third sentence',
    ]);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.dimensions).toBe(384);
      expect(r.embedding).toHaveLength(384);
    }
  });

  it('embedBatch returns empty array for empty input', async () => {
    const results = await provider.embedBatch([]);
    expect(results).toEqual([]);
  });

  it('implements EmbeddingProvider interface (compatible with VectorSearcher)', async () => {
    // Verify the provider satisfies the interface contract
    const ep: import('../src/retrieval/embedding-provider.js').EmbeddingProvider = provider;
    expect(ep.name).toBe('local-minilm');
    expect(ep.dimensions).toBe(384);
    const res = await ep.embed({ text: 'interface check' });
    expect(res.embedding).toHaveLength(384);
    expect(res.dimensions).toBe(384);
  });
}, 180_000); // 3 min timeout for entire suite (model loading)
