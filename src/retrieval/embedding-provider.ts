/**
 * EmbeddingProvider — abstraction for generating vector embeddings from text.
 *
 * Similar to LLMProvider for extraction, this interface allows swapping
 * between different embedding backends (OpenAI, Cohere, local models)
 * without changing retrieval logic.
 *
 * Designed to be replaced by a dedicated local ML model in the future.
 */

// ─── Embedding Request / Response ────────────────────────────────

export interface EmbeddingRequest {
  /** Text to embed */
  text: string;
  /** Optional model identifier (provider-specific) */
  model?: string;
}

export interface EmbeddingResponse {
  /** The embedding vector */
  embedding: number[];
  /** Dimensionality of the embedding */
  dimensions: number;
  /** Optional token usage stats */
  usage?: {
    promptTokens: number;
    totalTokens: number;
  };
}

// ─── EmbeddingProvider Interface ─────────────────────────────────

/**
 * Abstract interface for embedding providers.
 * Implementations handle the actual embedding API communication.
 */
export interface EmbeddingProvider {
  /** Provider name for logging/debugging */
  readonly name: string;

  /** Dimensionality of embeddings produced by this provider */
  readonly dimensions: number;

  /**
   * Generate an embedding vector for a single text input.
   */
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;

  /**
   * Batch-embed multiple texts (more efficient than individual calls).
   * Default implementation calls embed() sequentially.
   */
  embedBatch?(texts: string[]): Promise<EmbeddingResponse[]>;
}

// ─── MockEmbeddingProvider ───────────────────────────────────────

/**
 * A mock embedding provider for testing that generates deterministic
 * embeddings based on text content.
 *
 * The mock uses a simple hash-based approach to generate consistent
 * embeddings for the same input text, allowing reproducible tests.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly dimensions: number;
  public calls: EmbeddingRequest[] = [];
  private overrides = new Map<string, number[]>();

  constructor(dimensions: number = 64) {
    this.dimensions = dimensions;
  }

  /**
   * Register a specific embedding vector for a given text.
   * Useful for controlling similarity in tests.
   */
  setEmbedding(text: string, embedding: number[]): void {
    this.overrides.set(text, embedding);
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    this.calls.push(request);

    const override = this.overrides.get(request.text);
    if (override) {
      return {
        embedding: override,
        dimensions: override.length,
      };
    }

    const embedding = this.generateDeterministicEmbedding(request.text);
    return {
      embedding,
      dimensions: this.dimensions,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResponse[]> {
    return Promise.all(
      texts.map(text => this.embed({ text })),
    );
  }

  /** Reset state for test isolation */
  reset(): void {
    this.calls = [];
    this.overrides.clear();
  }

  /**
   * Generate a deterministic embedding from text using a simple hash.
   * Same text always produces the same vector, enabling reproducible tests.
   * Different texts produce different (but not meaningfully similar) vectors.
   */
  private generateDeterministicEmbedding(text: string): number[] {
    const vec = new Array<number>(this.dimensions);
    let hash = 0;

    // Simple string hash seed
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }

    // Generate deterministic pseudo-random vector
    for (let i = 0; i < this.dimensions; i++) {
      // LCG-style pseudo-random from hash
      hash = (hash * 1664525 + 1013904223) | 0;
      vec[i] = (hash & 0x7fffffff) / 0x7fffffff; // [0, 1]
    }

    // L2-normalize the vector for cosine similarity consistency
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        vec[i] /= norm;
      }
    }

    return vec;
  }
}
