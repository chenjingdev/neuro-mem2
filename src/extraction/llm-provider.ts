/**
 * LLM Provider interface — abstracts LLM API calls for memory extraction.
 *
 * This interface allows swapping between different LLM backends
 * (OpenAI, Anthropic, local models) without changing extraction logic.
 * Designed to be replaced by a dedicated ML model in the future.
 */

export interface LLMCompletionRequest {
  /** System prompt */
  system: string;
  /** User prompt */
  prompt: string;
  /** Expected response format */
  responseFormat?: 'json' | 'text';
  /** Temperature (0.0 = deterministic, 1.0 = creative) */
  temperature?: number;
  /** Maximum tokens in response */
  maxTokens?: number;
}

export interface LLMCompletionResponse {
  /** Raw text content from the LLM */
  content: string;
  /** Token usage stats (optional) */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Abstract interface for LLM providers.
 * Implementations handle the actual API communication.
 */
export interface LLMProvider {
  /** Provider name for logging/debugging */
  readonly name: string;

  /**
   * Send a completion request and get a response.
   * Implementations should handle retries and error formatting.
   */
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}

/**
 * A mock LLM provider for testing that returns predefined responses.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  private responses: string[] = [];
  private callIndex = 0;
  public calls: LLMCompletionRequest[] = [];

  /**
   * Queue a response to be returned on the next call.
   */
  addResponse(response: string): void {
    this.responses.push(response);
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    this.calls.push(request);
    const content = this.responses[this.callIndex] ?? '{"facts": []}';
    this.callIndex++;
    return { content };
  }

  /** Reset state for test isolation */
  reset(): void {
    this.responses = [];
    this.callIndex = 0;
    this.calls = [];
  }
}
