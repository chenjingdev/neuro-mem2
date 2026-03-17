/**
 * LocalEmbeddingProvider — runs all-MiniLM-L6-v2 locally via @huggingface/transformers.
 *
 * No external API calls. The ONNX model (~80 MB) is downloaded once on first use
 * and cached locally by the transformers runtime.
 *
 * Produces 384-dimensional L2-normalized embeddings identical to the Sentence-Transformers
 * all-MiniLM-L6-v2 model.
 */

import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from './embedding-provider.js';

// ─── Constants ─────────────────────────────────────────────────

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

// ─── Lazy singleton pipeline ───────────────────────────────────

// We lazily import @huggingface/transformers and cache the pipeline
// so the heavy ONNX model is loaded once per process lifetime.
let pipelinePromise: Promise<any> | null = null;

async function getFeatureExtractionPipeline(): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      // 'feature-extraction' task returns dense embeddings
      return pipeline('feature-extraction', MODEL_NAME, {
        // Use default quantization (q8 or fp32 depending on platform)
        dtype: 'fp32',
      });
    })();
  }
  return pipelinePromise;
}

// ─── Helpers ───────────────────────────────────────────────────

/**
 * L2-normalize a vector in-place and return it.
 */
function l2Normalize(vec: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }
  return vec;
}

/**
 * Mean-pool token embeddings into a single sentence embedding.
 * Input shape: [1, seqLen, hiddenDim]  =>  [hiddenDim]
 */
function meanPool(output: any): number[] {
  const data: Float32Array | number[] = output.data ?? output;
  const dims: number[] = output.dims ?? output.size;

  // output.dims = [1, seqLen, hiddenDim]
  const seqLen = dims[1];
  const hiddenDim = dims[2];

  const pooled = new Array<number>(hiddenDim).fill(0);
  for (let t = 0; t < seqLen; t++) {
    const offset = t * hiddenDim;
    for (let d = 0; d < hiddenDim; d++) {
      pooled[d] += data[offset + d];
    }
  }
  for (let d = 0; d < hiddenDim; d++) {
    pooled[d] /= seqLen;
  }
  return pooled;
}

// ─── LocalEmbeddingProvider ────────────────────────────────────

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local-minilm';
  readonly dimensions = EMBEDDING_DIM;

  private _initPromise: Promise<void> | null = null;
  private _ready = false;

  /**
   * Optionally warm up the model so the first embed() call is fast.
   * This is NOT required — embed() lazily initialises on first call.
   */
  async warmup(): Promise<void> {
    if (this._ready) return;
    if (!this._initPromise) {
      this._initPromise = getFeatureExtractionPipeline().then(() => {
        this._ready = true;
      });
    }
    return this._initPromise;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const pipe = await getFeatureExtractionPipeline();

    const output = await pipe(request.text, {
      pooling: 'mean',
      normalize: true,
    });

    // output is a Tensor — convert to plain number[]
    let embedding: number[];
    if (output.tolist) {
      // Tensor.tolist() returns nested arrays: [[...384 floats]]
      const nested = output.tolist();
      embedding = Array.isArray(nested[0]) ? nested[0] : nested;
    } else if (output.data) {
      // Fallback: raw typed array with mean pooling
      embedding = l2Normalize(meanPool(output));
    } else {
      throw new Error('Unexpected output format from feature-extraction pipeline');
    }

    return {
      embedding,
      dimensions: embedding.length,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResponse[]> {
    if (texts.length === 0) return [];

    const pipe = await getFeatureExtractionPipeline();

    // Process texts individually to avoid padding complexity
    // For all-MiniLM-L6-v2 the per-text overhead is negligible
    const results: EmbeddingResponse[] = [];
    for (const text of texts) {
      const output = await pipe(text, {
        pooling: 'mean',
        normalize: true,
      });

      let embedding: number[];
      if (output.tolist) {
        const nested = output.tolist();
        embedding = Array.isArray(nested[0]) ? nested[0] : nested;
      } else if (output.data) {
        embedding = l2Normalize(meanPool(output));
      } else {
        throw new Error('Unexpected output format from feature-extraction pipeline');
      }

      results.push({
        embedding,
        dimensions: embedding.length,
      });
    }

    return results;
  }
}

/**
 * Reset the cached pipeline — useful for testing or process cleanup.
 */
export function resetLocalEmbeddingPipeline(): void {
  pipelinePromise = null;
}
