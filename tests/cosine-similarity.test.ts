/**
 * Tests for cosine-similarity module.
 *
 * Covers:
 * - Core cosine similarity (number[], Float32Array, mixed)
 * - Edge cases (zero vectors, empty, mismatched dimensions)
 * - Batch operations with top-K and threshold filtering
 * - Buffer ↔ Float32Array conversion
 * - L2 normalization and utility functions
 * - Backward compatibility (cosineSimilarityVec alias)
 */

import { describe, it, expect } from 'vitest';
import {
  cosineSimilarity,
  cosineSimilarityRaw,
  cosineSimilarityVec,
  batchCosineSimilarity,
  bufferToFloat32Array,
  float32ArrayToBuffer,
  l2Normalize,
  l2Norm,
  dotProduct,
} from '../src/retrieval/cosine-similarity.js';

// ─── Helpers ─────────────────────────────────────────────────────

function approx(value: number, expected: number, tolerance = 1e-6): void {
  expect(Math.abs(value - expected)).toBeLessThan(tolerance);
}

/** Create a random normalized vector of given dimension */
function randomNormalizedVector(dim: number, seed = 42): number[] {
  let hash = seed;
  const vec: number[] = [];
  for (let i = 0; i < dim; i++) {
    hash = (hash * 1664525 + 1013904223) | 0;
    vec.push((hash & 0x7fffffff) / 0x7fffffff);
  }
  return l2Normalize(vec);
}

// ─── Core cosineSimilarity ───────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const vec = [1, 2, 3, 4, 5];
    approx(cosineSimilarity(vec, vec), 1.0);
  });

  it('returns 1.0 for identical normalized vectors', () => {
    const vec = l2Normalize([0.5, 0.3, 0.8, 0.1]);
    approx(cosineSimilarity(vec, vec), 1.0);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    approx(cosineSimilarity(a, b), 0.0);
  });

  it('returns 0 for opposite vectors (clamped)', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('computes correct similarity for known vectors', () => {
    // cos([1,2,3], [4,5,6]) = 32 / (sqrt(14) * sqrt(77)) ≈ 0.9746
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    approx(cosineSimilarity(a, b), 0.974632, 1e-4);
  });

  it('works with Float32Array inputs', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    approx(cosineSimilarity(a, b), 0.974632, 1e-4);
  });

  it('works with mixed number[] and Float32Array', () => {
    const a = [1, 2, 3];
    const b = new Float32Array([4, 5, 6]);
    approx(cosineSimilarity(a, b), 0.974632, 1e-4);
  });

  it('handles 384-dim vectors (all-MiniLM-L6-v2 size)', () => {
    const a = randomNormalizedVector(384, 1);
    const b = randomNormalizedVector(384, 2);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it('similarity of unit vector with itself is 1.0 at 384 dims', () => {
    const a = randomNormalizedVector(384, 42);
    approx(cosineSimilarity(a, a), 1.0, 1e-5);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('returns 0 when one vector is zero', () => {
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('handles mismatched dimensions (uses min length)', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [1, 2, 3];
    // Uses only first 3 elements: cos([1,2,3], [1,2,3]) = 1.0
    approx(cosineSimilarity(a, b), 1.0);
  });

  it('produces consistent results regardless of input type', () => {
    const arrA = [0.5, -0.3, 0.8, 0.1, -0.6];
    const arrB = [0.2, 0.7, -0.4, 0.9, 0.1];
    const f32A = new Float32Array(arrA);
    const f32B = new Float32Array(arrB);

    const result1 = cosineSimilarity(arrA, arrB);
    const result2 = cosineSimilarity(f32A, f32B);
    const result3 = cosineSimilarity(arrA, f32B);
    const result4 = cosineSimilarity(f32A, arrB);

    // Float32 has less precision, so allow small tolerance
    approx(result1, result2, 1e-5);
    approx(result1, result3, 1e-5);
    approx(result1, result4, 1e-5);
  });
});

// ─── cosineSimilarityRaw ─────────────────────────────────────────

describe('cosineSimilarityRaw', () => {
  it('returns negative values for anti-correlated vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    approx(cosineSimilarityRaw(a, b), -1.0);
  });

  it('returns full range [-1, 1]', () => {
    approx(cosineSimilarityRaw([1, 0], [1, 0]), 1.0);
    approx(cosineSimilarityRaw([1, 0], [0, 1]), 0.0);
    approx(cosineSimilarityRaw([1, 0], [-1, 0]), -1.0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarityRaw([], [])).toBe(0);
  });
});

// ─── Backward Compatibility ──────────────────────────────────────

describe('cosineSimilarityVec (backward compat)', () => {
  it('is the same function as cosineSimilarity', () => {
    expect(cosineSimilarityVec).toBe(cosineSimilarity);
  });

  it('produces identical results', () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    expect(cosineSimilarityVec(a, b)).toBe(cosineSimilarity(a, b));
  });
});

// ─── Batch Operations ────────────────────────────────────────────

describe('batchCosineSimilarity', () => {
  const query = l2Normalize([1, 0, 0, 0]);
  const candidates = [
    { id: 'exact', embedding: l2Normalize([1, 0, 0, 0]) },
    { id: 'similar', embedding: l2Normalize([0.9, 0.1, 0, 0]) },
    { id: 'orthogonal', embedding: l2Normalize([0, 1, 0, 0]) },
    { id: 'moderate', embedding: l2Normalize([0.5, 0.5, 0, 0]) },
  ];

  it('returns results sorted by similarity descending', () => {
    const results = batchCosineSimilarity(query, candidates);
    expect(results.length).toBe(4);
    expect(results[0].id).toBe('exact');
    for (let i = 1; i < results.length; i++) {
      expect(results[i].similarity).toBeLessThanOrEqual(results[i - 1].similarity);
    }
  });

  it('respects topK limit', () => {
    const results = batchCosineSimilarity(query, candidates, 2);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('exact');
  });

  it('filters by minSimilarity threshold', () => {
    const results = batchCosineSimilarity(query, candidates, candidates.length, 0.9);
    // Only 'exact' and 'similar' should pass (both ≥0.9)
    expect(results.length).toBe(2);
    expect(results.every(r => r.similarity >= 0.9)).toBe(true);
  });

  it('returns empty for empty candidates', () => {
    expect(batchCosineSimilarity(query, [])).toEqual([]);
  });

  it('returns empty for zero query vector', () => {
    expect(batchCosineSimilarity([0, 0, 0], candidates)).toEqual([]);
  });

  it('preserves correct index references', () => {
    const results = batchCosineSimilarity(query, candidates);
    for (const r of results) {
      expect(candidates[r.index].id).toBe(r.id);
    }
  });

  it('handles Float32Array candidates', () => {
    const f32Candidates = candidates.map(c => ({
      id: c.id,
      embedding: new Float32Array(c.embedding),
    }));
    const results = batchCosineSimilarity(query, f32Candidates);
    expect(results.length).toBe(4);
    expect(results[0].id).toBe('exact');
  });

  it('handles 384-dim vectors efficiently', () => {
    const q = randomNormalizedVector(384, 1);
    const cands = Array.from({ length: 200 }, (_, i) => ({
      id: `node-${i}`,
      embedding: randomNormalizedVector(384, i + 100),
    }));

    const start = performance.now();
    const results = batchCosineSimilarity(q, cands, 20);
    const elapsed = performance.now() - start;

    expect(results.length).toBe(20);
    // Should complete in well under 50ms for 200 candidates
    expect(elapsed).toBeLessThan(50);
  });
});

// ─── Buffer Conversion ───────────────────────────────────────────

describe('bufferToFloat32Array', () => {
  it('converts a valid buffer to Float32Array', () => {
    const original = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    const buffer = Buffer.from(original.buffer, original.byteOffset, original.byteLength);
    const result = bufferToFloat32Array(buffer, 4);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
    approx(result![0], 1.0);
    approx(result![3], 4.0);
  });

  it('returns null for null buffer', () => {
    expect(bufferToFloat32Array(null, 4)).toBeNull();
  });

  it('returns null for null dimension', () => {
    const buffer = Buffer.alloc(16);
    expect(bufferToFloat32Array(buffer, null)).toBeNull();
  });

  it('returns null for zero dimension', () => {
    const buffer = Buffer.alloc(16);
    expect(bufferToFloat32Array(buffer, 0)).toBeNull();
  });

  it('returns null for negative dimension', () => {
    const buffer = Buffer.alloc(16);
    expect(bufferToFloat32Array(buffer, -1)).toBeNull();
  });
});

describe('float32ArrayToBuffer', () => {
  it('converts Float32Array to Buffer and back', () => {
    const original = new Float32Array([0.5, -0.3, 0.8, 0.1]);
    const buffer = float32ArrayToBuffer(original);
    const restored = bufferToFloat32Array(buffer, 4);
    expect(restored).not.toBeNull();
    for (let i = 0; i < original.length; i++) {
      approx(restored![i], original[i]);
    }
  });

  it('roundtrip preserves 384-dim embedding', () => {
    const vec = randomNormalizedVector(384, 42);
    const f32 = new Float32Array(vec);
    const buffer = float32ArrayToBuffer(f32);
    const restored = bufferToFloat32Array(buffer, 384);
    expect(restored).not.toBeNull();
    expect(restored!.length).toBe(384);
    // Verify cosine similarity with original is ~1.0
    approx(cosineSimilarity(vec, restored!), 1.0, 1e-5);
  });
});

// ─── Vector Utilities ────────────────────────────────────────────

describe('l2Normalize', () => {
  it('normalizes a vector to unit length', () => {
    const vec = l2Normalize([3, 4]);
    approx(vec[0], 0.6);
    approx(vec[1], 0.8);
    approx(l2Norm(vec), 1.0);
  });

  it('handles zero vector without error', () => {
    const vec = l2Normalize([0, 0, 0]);
    expect(vec).toEqual([0, 0, 0]);
  });

  it('normalizes in-place', () => {
    const vec = [3, 4];
    const result = l2Normalize(vec);
    expect(result).toBe(vec); // Same reference
  });
});

describe('l2Norm', () => {
  it('computes correct L2 norm', () => {
    approx(l2Norm([3, 4]), 5.0);
  });

  it('returns 0 for zero vector', () => {
    expect(l2Norm([0, 0, 0])).toBe(0);
  });

  it('returns 1 for unit vector', () => {
    approx(l2Norm([1, 0, 0]), 1.0);
  });

  it('works with Float32Array', () => {
    approx(l2Norm(new Float32Array([3, 4])), 5.0, 1e-5);
  });
});

describe('dotProduct', () => {
  it('computes correct dot product', () => {
    approx(dotProduct([1, 2, 3], [4, 5, 6]), 32);
  });

  it('returns 0 for orthogonal vectors', () => {
    approx(dotProduct([1, 0], [0, 1]), 0);
  });

  it('handles mismatched dimensions', () => {
    // Uses min length (2)
    approx(dotProduct([1, 2, 3], [4, 5]), 14);
  });

  it('works with Float32Array', () => {
    approx(dotProduct(new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])), 32, 1e-4);
  });
});
