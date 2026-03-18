/**
 * Chat API Router — Hono-based SSE streaming endpoint for the Visual Debug Chat App.
 *
 * Provides a POST /chat endpoint that:
 *   1. Accepts a user message (+ optional conversation history)
 *   2. Runs the full memory pipeline (recall) with tracing
 *   3. Calls the LLM provider's stream() method with recalled context
 *   4. Runs the ingestion pipeline (fact extraction) on the completed turn
 *   5. Streams responses back via SSE with two event types:
 *      - event:trace  — pipeline stage data (recall, ingestion, timing, etc.)
 *      - event:chat   — incremental LLM response tokens + finish/error
 *   6. Sends a final event:done with data: [DONE]
 *
 * This router is mounted on the existing Hono server alongside the main API routes.
 * It does NOT go through the ProxyServer — it orchestrates the pipeline directly.
 *
 * Design:
 *   - localhost only, no authentication
 *   - Single SSE stream per request
 *   - Fixed userId "debug-user"
 *
 * SSE Event Protocol:
 *   event: trace\ndata: {"stage":"recall","status":"start",...}\n\n
 *   event: trace\ndata: {"stage":"vector_search","status":"start",...}\n\n
 *   event: trace\ndata: {"stage":"vector_search","status":"complete",...}\n\n
 *   event: trace\ndata: {"stage":"graph_traversal","status":"start",...}\n\n
 *   event: trace\ndata: {"stage":"graph_traversal","status":"complete",...}\n\n
 *   event: trace\ndata: {"stage":"merge","status":"start",...}\n\n
 *   event: trace\ndata: {"stage":"merge","status":"complete",...}\n\n
 *   event: trace\ndata: {"stage":"reinforce","status":"complete|skipped",...}\n\n
 *   event: trace\ndata: {"stage":"recall","status":"complete",...}\n\n
 *   event: trace\ndata: {"stage":"llm","status":"start",...}\n\n
 *   event: chat\ndata: {"type":"delta","content":"Hello"}\n\n
 *   event: chat\ndata: {"type":"finish","content":"Hello world",...}\n\n
 *   event: trace\ndata: {"stage":"llm","status":"complete",...}\n\n
 *   event: trace\ndata: {"stage":"ingestion","status":"start",...}\n\n
 *   event: trace\ndata: {"stage":"ingestion","status":"complete","data":{"factCount":2,"facts":[...]}}\n\n
 *   event: trace\ndata: {"stage":"pipeline","status":"complete",...}\n\n
 *   event: done\ndata: [DONE]\n\n
 */

import { Hono } from 'hono';
import type { LLMProvider, LLMStreamRequest, LLMChatMessage } from '../extraction/llm-provider.js';
import type { DualPathRetriever, RecallResult, RecallTraceHook, RecallTraceEvent } from '../retrieval/dual-path-retriever.js';
import type { FactExtractor, FactExtractionResult } from '../extraction/fact-extractor.js';
import type { FactExtractionInput } from '../models/fact.js';
import type { EventBus, FactsExtractedEvent, ExtractionErrorEvent } from '../events/event-bus.js';
import type { IngestService } from '../services/ingest.js';
import type { UnifiedRetriever, UnifiedRecallResult, UnifiedTraceEvent } from '../retrieval/unified-retriever.js';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { formatSSE, safeSerialize } from './sse-helpers.js';
import {
  getOrCreateConversation,
  saveChatTurn,
  type SaveChatTurnResult,
} from './db/conversationRepo.js';
import { savePipelineTraceEvents } from './db/traceRepo.js';

// ─── Types ────────────────────────────────────────────────

/** Incoming chat request body. */
export interface ChatRequest {
  /** The user's message text */
  message: string;
  /** Optional session ID for continuing a conversation */
  sessionId?: string;
  /** Previous conversation messages (optional) */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Optional LLM provider override ('openai' | 'anthropic') */
  provider?: 'openai' | 'anthropic';
  /** Optional model override */
  model?: string;
  /** Optional temperature */
  temperature?: number;
  /** Optional max tokens for LLM response */
  maxTokens?: number;
  /** Optional system prompt override */
  systemPrompt?: string;
}

/** SSE trace event — emitted for each pipeline stage. */
export interface TraceEvent {
  /** Pipeline stage name */
  stage: string;
  /** Stage status */
  status: 'start' | 'complete' | 'error' | 'skipped';
  /** Duration in ms (only on 'complete' or 'error') */
  durationMs?: number;
  /** Stage-specific data payload */
  data?: unknown;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** SSE chat event — emitted for each LLM response chunk. */
export interface ChatEvent {
  /** Event type: delta for tokens, finish for completed response, error for failures */
  type: 'delta' | 'finish' | 'error';
  /** Text content (delta text or full response) */
  content?: string;
  /** Error message (only on type: 'error') */
  error?: string;
  /** Token usage stats (only on type: 'finish') */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** SSE done event data — signals stream completion. */
export interface DoneEvent {
  /** Full assembled response text */
  fullResponse: string;
  /** Total pipeline duration in ms */
  totalDurationMs: number;
  /** All collected trace events for this pipeline run (for timeline rendering & storage) */
  traceEvents?: TraceEvent[];
}

/** Validation error structure. */
interface ChatValidationError {
  error: string;
  message: string;
  details?: string[];
}

/**
 * Ingestion handler interface — called after LLM response to store
 * the conversation turn into the memory pipeline.
 *
 * This is a clean abstraction that decouples the chat router from
 * the internal FactExtractor/EventBus plumbing.
 */
export interface IngestionHandler {
  /**
   * Ingest a user+assistant turn into the memory pipeline.
   * Returns extraction results (facts found, etc.) for tracing.
   */
  ingest(params: {
    userMessage: string;
    assistantMessage: string;
    sessionId?: string;
  }): Promise<{ factCount: number; facts?: Array<{ content: string }>; error?: string }>;
}

// ─── Constants ────────────────────────────────────────────

const DEBUG_USER_ID = 'debug-user';

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant with access to a memory system. Use the provided memory context to give informed, personalized responses. If the memory context is relevant to the user's question, reference it naturally in your response.`;

// ─── SSE Helpers (re-exported from sse-helpers.ts) ────────
// formatSSE and safeSerialize are imported from ./sse-helpers.js
export { formatSSE, safeSerialize } from './sse-helpers.js';

// ─── TraceCollector ───────────────────────────────────────

/**
 * Collects all TraceEvent objects emitted during a pipeline run.
 *
 * Used alongside the SSEWriter so trace events are both streamed to
 * the client AND collected for:
 *   - Inclusion in the final DoneEvent (for client-side timeline rendering)
 *   - Persistence to SQLite for historical debugging
 */
export class TraceCollector {
  private events: TraceEvent[] = [];

  /** Record a trace event. */
  add(event: TraceEvent): void {
    this.events.push(event);
  }

  /** Get all collected trace events (immutable copy). */
  getAll(): TraceEvent[] {
    return [...this.events];
  }

  /** Get events for a specific stage. */
  getByStage(stage: string): TraceEvent[] {
    return this.events.filter((e) => e.stage === stage);
  }

  /** Get the number of collected events. */
  get count(): number {
    return this.events.length;
  }

  /**
   * Compute a summary of all completed/errored/skipped stages.
   * Useful for the pipeline:complete trace data.
   */
  getStageSummary(): Array<{ stage: string; status: string; durationMs?: number }> {
    return this.events
      .filter((e) => e.status === 'complete' || e.status === 'error' || e.status === 'skipped')
      .map((e) => ({
        stage: e.stage,
        status: e.status,
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      }));
  }
}

// ─── Request Validation ───────────────────────────────────

/**
 * Validate the incoming chat request body.
 * Returns an array of error messages (empty = valid).
 */
export function validateChatRequest(body: unknown): string[] {
  const errors: string[] = [];

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return ['Request body must be a JSON object'];
  }

  const obj = body as Record<string, unknown>;

  // message is required and must be a non-empty string
  if (typeof obj['message'] !== 'string' || obj['message'].trim().length === 0) {
    errors.push('`message` is required and must be a non-empty string');
  }

  // sessionId is optional but must be a string if present
  if (obj['sessionId'] !== undefined && typeof obj['sessionId'] !== 'string') {
    errors.push('`sessionId` must be a string if provided');
  }

  // history is optional but must be an array of chat messages
  if (obj['history'] !== undefined) {
    if (!Array.isArray(obj['history'])) {
      errors.push('`history` must be an array if provided');
    } else {
      for (let i = 0; i < obj['history'].length; i++) {
        const msg = obj['history'][i] as Record<string, unknown> | undefined;
        if (!msg || typeof msg !== 'object') {
          errors.push(`history[${i}] must be an object`);
          continue;
        }
        if (msg['role'] !== 'user' && msg['role'] !== 'assistant') {
          errors.push(`history[${i}].role must be 'user' or 'assistant'`);
        }
        if (!msg['content'] || typeof msg['content'] !== 'string') {
          errors.push(`history[${i}].content must be a non-empty string`);
        }
      }
    }
  }

  // provider is optional but must be 'openai' or 'anthropic'
  if (obj['provider'] !== undefined) {
    if (obj['provider'] !== 'openai' && obj['provider'] !== 'anthropic') {
      errors.push('`provider` must be "openai" or "anthropic"');
    }
  }

  // model is optional but must be a string
  if (obj['model'] !== undefined && typeof obj['model'] !== 'string') {
    errors.push('`model` must be a string if provided');
  }

  // temperature is optional but must be a number in [0, 2]
  if (obj['temperature'] !== undefined) {
    if (typeof obj['temperature'] !== 'number' || obj['temperature'] < 0 || obj['temperature'] > 2) {
      errors.push('`temperature` must be a number between 0 and 2');
    }
  }

  // maxTokens is optional but must be a positive integer
  if (obj['maxTokens'] !== undefined) {
    if (typeof obj['maxTokens'] !== 'number' || !Number.isInteger(obj['maxTokens']) || obj['maxTokens'] < 1) {
      errors.push('`maxTokens` must be a positive integer');
    }
  }

  return errors;
}

// ─── Router Dependencies ──────────────────────────────────

/**
 * Dependencies injected into the chat router.
 */
export interface ChatRouterDependencies {
  /** LLM provider with stream() support */
  llmProvider: LLMProvider;
  /** Dual-path memory retriever (optional — recall skipped if not provided) */
  retriever?: DualPathRetriever;
  /**
   * Unified retriever — single-pipeline brain-like retrieval using local embeddings
   * and anchor-association-based recall (replaces DualPathRetriever).
   * When provided, takes precedence over `retriever` for the recall phase.
   */
  unifiedRetriever?: UnifiedRetriever;
  /** Default system prompt (optional) */
  defaultSystemPrompt?: string;
  /** Fact extractor for ingestion pipeline tracing (optional — ingestion skipped if not provided) */
  factExtractor?: FactExtractor;
  /** Fact repository for storing/loading facts (optional — enables memory persistence) */
  factRepo?: import('../db/fact-repo.js').FactRepository;
  /** Event bus for emitting extraction events (optional) */
  eventBus?: EventBus;
  /** Ingest service for storing conversation turns (optional) */
  ingestService?: IngestService;
  /** Conversation ID to use for ingestion (auto-generated if not provided) */
  conversationId?: string;
  /**
   * Ingestion handler — cleaner abstraction for the ingestion phase.
   * When provided, this takes precedence over factExtractor for the
   * ingestion trace stage. Optional — ingestion skipped if not provided.
   */
  ingestionHandler?: IngestionHandler;
  /**
   * Chat debug database handle (optional).
   * When provided, conversations & messages are persisted to SQLite
   * and trace events are stored alongside messages.
   */
  chatDb?: Database.Database;
}

// ─── Internal: SSE writer abstraction ─────────────────────

/**
 * Wraps a ReadableStreamController for structured SSE writing.
 * Automatically collects all trace events via the TraceCollector.
 */
class SSEWriter {
  private encoder = new TextEncoder();
  private closed = false;

  constructor(
    private controller: ReadableStreamDefaultController<Uint8Array>,
    private collector: TraceCollector,
  ) {}

  /** Write a typed SSE event. */
  writeEvent(event: string, data: unknown): void {
    if (this.closed) return;
    try {
      this.controller.enqueue(this.encoder.encode(formatSSE(event, data)));
    } catch {
      this.closed = true;
    }
  }

  /**
   * Write a trace event to the SSE stream AND collect it.
   * The event is serialized as `event: trace\ndata: {JSON}\n\n`.
   */
  trace(event: TraceEvent): void {
    this.collector.add(event);
    this.writeEvent('trace', event);
  }

  /** Write a chat event. */
  chat(event: ChatEvent): void {
    this.writeEvent('chat', event);
  }

  /**
   * Write the terminal done event (includes collected trace events
   * for client-side timeline rendering) and close the stream.
   */
  done(fullResponse: string, totalDurationMs: number): void {
    if (this.closed) return;
    const doneEvent: DoneEvent = {
      fullResponse,
      totalDurationMs,
      traceEvents: this.collector.getAll(),
    };
    this.writeEvent('done', doneEvent);
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // Stream may already be closed
    }
  }

  /** Close the stream (error path). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // Stream may already be closed
    }
  }

  /** Get the collector for external inspection (e.g., pipeline summary). */
  getCollector(): TraceCollector {
    return this.collector;
  }
}

// ─── Pipeline orchestration ───────────────────────────────

/** Result returned by the pipeline for persistence. */
interface PipelineResult {
  fullResponse: string;
  totalDurationMs: number;
  model?: string;
}

/**
 * Execute the full chat pipeline: recall → LLM streaming.
 * All events are written to the SSE writer.
 * Returns the pipeline result for persistence.
 */
async function executePipeline(
  writer: SSEWriter,
  request: ChatRequest,
  deps: ChatRouterDependencies,
): Promise<PipelineResult> {
  const pipelineStart = performance.now();
  let fullResponse = '';

  // ── Phase 1: Memory Recall ──
  let memoryContext = '';
  let recallResult: RecallResult | null = null;
  let unifiedResult: UnifiedRecallResult | null = null;

  // ── Phase 1A: Unified Retriever (preferred — brain-like anchor-association recall) ──
  if (deps.unifiedRetriever) {
    writer.trace({
      stage: 'recall',
      status: 'start',
      data: { query: request.message, userId: DEBUG_USER_ID, mode: 'unified' },
      timestamp: new Date().toISOString(),
    });

    const recallStart = performance.now();

    // Forward unified pipeline trace events to SSE
    const unifiedTraceHook = (event: UnifiedTraceEvent) => {
      writer.trace({
        stage: event.stage,
        status: event.status,
        durationMs: event.durationMs,
        data: event.detail ?? {},
        timestamp: new Date().toISOString(),
      });
    };

    try {
      // Create a temporary retriever instance with the trace hook wired up
      // The UnifiedRetriever accepts traceHook in its constructor, but we can
      // also just call recall() and map the diagnostics.stages to trace events.
      unifiedResult = await deps.unifiedRetriever.recall({
        text: request.message,
      });

      const recallDuration = round2(performance.now() - recallStart);

      // Emit sub-stage trace events from diagnostics for pipeline traceability
      for (const stage of unifiedResult.diagnostics.stages) {
        writer.trace({
          stage: stage.name,
          status: stage.status,
          durationMs: stage.durationMs,
          data: stage.detail ? { detail: stage.detail } : {},
          timestamp: new Date().toISOString(),
        });
      }

      // Build memory context from unified recall items
      if (unifiedResult.items.length > 0) {
        memoryContext = unifiedResult.items
          .map(
            (item, i) =>
              `[Memory ${i + 1}] (${item.nodeType}, score: ${item.score.toFixed(3)}): ${item.content}`,
          )
          .join('\n');
      }

      writer.trace({
        stage: 'recall',
        status: 'complete',
        durationMs: recallDuration,
        data: {
          mode: 'unified',
          itemCount: unifiedResult.items.length,
          activatedAnchors: unifiedResult.activatedAnchors.map(a => ({
            anchorId: a.anchorId,
            label: a.label,
            similarity: a.similarity,
          })),
          diagnostics: {
            embeddingTimeMs: unifiedResult.diagnostics.embeddingTimeMs,
            anchorSearchTimeMs: unifiedResult.diagnostics.anchorSearchTimeMs,
            bfsNodesAdded: unifiedResult.diagnostics.bfsNodesAdded,
            edgesReinforced: unifiedResult.diagnostics.edgesReinforced,
            totalTimeMs: unifiedResult.diagnostics.totalTimeMs,
          },
        },
        timestamp: new Date().toISOString(),
      });
    } catch (recallErr) {
      const recallDuration = round2(performance.now() - recallStart);

      writer.trace({
        stage: 'recall',
        status: 'error',
        durationMs: recallDuration,
        data: {
          mode: 'unified',
          error: recallErr instanceof Error ? recallErr.message : String(recallErr),
        },
        timestamp: new Date().toISOString(),
      });
      // Non-fatal — continue without memory context
    }
  } else if (deps.retriever) {
    writer.trace({
      stage: 'recall',
      status: 'start',
      data: { query: request.message, userId: DEBUG_USER_ID },
      timestamp: new Date().toISOString(),
    });

    const recallStart = performance.now();

    // Create a trace hook that forwards recall sub-stage events to SSE
    const recallTraceHook: RecallTraceHook = (event: RecallTraceEvent) => {
      writer.trace({
        stage: event.stage,
        status: event.status,
        durationMs: event.durationMs,
        data: {
          ...(event.input !== undefined ? { input: event.input } : {}),
          ...(event.output !== undefined ? { output: event.output } : {}),
          ...(event.error !== undefined ? { error: event.error } : {}),
          ...(event.skipReason !== undefined ? { reason: event.skipReason } : {}),
        },
        timestamp: event.timestamp,
      });
    };

    try {
      recallResult = await deps.retriever.recall({
        queryText: request.message,
        traceHook: recallTraceHook,
      });
      const recallDuration = round2(performance.now() - recallStart);

      writer.trace({
        stage: 'recall',
        status: 'complete',
        durationMs: recallDuration,
        data: {
          itemCount: recallResult.items.length,
          diagnostics: recallResult.diagnostics,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (recallErr) {
      const recallDuration = round2(performance.now() - recallStart);

      writer.trace({
        stage: 'recall',
        status: 'error',
        durationMs: recallDuration,
        data: {
          error: recallErr instanceof Error ? recallErr.message : String(recallErr),
        },
        timestamp: new Date().toISOString(),
      });
      // Non-fatal — continue without memory context
    }
  } else {
    writer.trace({
      stage: 'recall',
      status: 'skipped',
      data: { reason: 'No retriever configured' },
      timestamp: new Date().toISOString(),
    });
  }

  // ── Phase 1b: Fact-based recall fallback (no embedding API needed) ──
  // If vector/graph/unified recall returned no items, load recent facts directly from DB.
  const recallItems = recallResult?.items ?? unifiedResult?.items ?? [];
  if (recallItems.length === 0 && deps.factRepo) {
    const factRecallStart = performance.now();

    writer.trace({
      stage: 'fact_recall',
      status: 'start',
      data: { reason: 'Vector/graph recall empty, loading recent facts from DB' },
      timestamp: new Date().toISOString(),
    });

    try {
      const recentFacts = deps.factRepo.getRecent(30);
      const factRecallDuration = round2(performance.now() - factRecallStart);

      if (recentFacts.length > 0) {
        // Build memory context from stored facts
        memoryContext = recentFacts
          .map((f, i) => `[${i + 1}] ${f.content}`)
          .join('\n');

        writer.trace({
          stage: 'fact_recall',
          status: 'complete',
          durationMs: factRecallDuration,
          data: {
            factCount: recentFacts.length,
            facts: recentFacts.map(f => ({
              id: f.id,
              content: f.content,
              category: f.category,
              confidence: f.confidence,
            })),
          },
          timestamp: new Date().toISOString(),
        });
      } else {
        writer.trace({
          stage: 'fact_recall',
          status: 'complete',
          durationMs: factRecallDuration,
          data: { factCount: 0, message: 'No stored facts yet' },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      const factRecallDuration = round2(performance.now() - factRecallStart);
      writer.trace({
        stage: 'fact_recall',
        status: 'error',
        durationMs: factRecallDuration,
        data: { error: err instanceof Error ? err.message : String(err) },
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── Phase 2a: Format — convert merged items into context string ──

  const formatStart = performance.now();

  const totalRecallItems = recallResult?.items.length ?? unifiedResult?.items.length ?? 0;

  writer.trace({
    stage: 'format',
    status: 'start',
    data: {
      itemCount: totalRecallItems,
      format: 'numbered-list',
      source: unifiedResult ? 'unified' : recallResult ? 'dual-path' : 'none',
    },
    timestamp: new Date().toISOString(),
  });

  // For DualPathRetriever results, build memory context here
  // (Unified retriever already built memoryContext in Phase 1A)
  if (!unifiedResult && recallResult && recallResult.items.length > 0) {
    memoryContext = recallResult.items
      .map(
        (item, i) =>
          `[Memory ${i + 1}] (${item.nodeType}, score: ${item.score.toFixed(3)}): ${item.content}`,
      )
      .join('\n');
  }

  const formatDuration = round2(performance.now() - formatStart);
  const formatTruncated = memoryContext.length > 8000;
  const formattedContext = formatTruncated ? memoryContext.slice(0, 8000) : memoryContext;

  writer.trace({
    stage: 'format',
    status: 'complete',
    durationMs: formatDuration,
    data: {
      charCount: memoryContext.length,
      truncated: formatTruncated,
      itemsIncluded: totalRecallItems,
      contextPreview: memoryContext.slice(0, 300),
    },
    timestamp: new Date().toISOString(),
  });

  // ── Phase 2b: Inject — attach context to the LLM prompt ──

  const injectStart = performance.now();
  const baseSystemPrompt = request.systemPrompt ?? deps.defaultSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  writer.trace({
    stage: 'inject',
    status: 'start',
    data: {
      hasMemoryContext: formattedContext.length > 0,
      contextCharCount: formattedContext.length,
      systemPromptLength: baseSystemPrompt.length,
    },
    timestamp: new Date().toISOString(),
  });

  let effectiveSystemPrompt = baseSystemPrompt;
  if (formattedContext) {
    effectiveSystemPrompt += `\n\n## Retrieved Memory Context\n${formattedContext}`;
  }

  // Build messages: history + current user message
  const messages: LLMChatMessage[] = [
    ...(request.history ?? []),
    { role: 'user' as const, content: request.message },
  ];

  const streamRequest: LLMStreamRequest = {
    system: effectiveSystemPrompt,
    messages,
    model: request.model,
    sessionId: request.sessionId,
    temperature: request.temperature ?? 0.7,
    maxTokens: request.maxTokens,
  };

  const injectDuration = round2(performance.now() - injectStart);

  writer.trace({
    stage: 'inject',
    status: 'complete',
    durationMs: injectDuration,
    data: {
      finalPromptLength: effectiveSystemPrompt.length,
      messageCount: messages.length,
      hasMemoryContext: formattedContext.length > 0,
    },
    timestamp: new Date().toISOString(),
  });

  // ── Phase 3: LLM Streaming ──

  writer.trace({
    stage: 'llm',
    status: 'start',
    data: {
      provider: deps.llmProvider.name,
      messageCount: messages.length,
      hasMemoryContext: memoryContext.length > 0,
    },
    timestamp: new Date().toISOString(),
  });

  const llmStart = performance.now();

  if (!deps.llmProvider.stream) {
    // Provider doesn't support streaming — fall back to complete()
    try {
      const result = await deps.llmProvider.complete({
        system: effectiveSystemPrompt,
        prompt: request.message,
        model: request.model,
        sessionId: request.sessionId,
        temperature: request.temperature ?? 0.7,
        maxTokens: request.maxTokens,
      });

      fullResponse = result.content;

      // Emit the entire response as a single delta + finish
      writer.chat({ type: 'delta', content: result.content });
      writer.chat({
        type: 'finish',
        content: result.content,
        usage: result.usage,
      });

      const llmDuration = round2(performance.now() - llmStart);
      writer.trace({
        stage: 'llm',
        status: 'complete',
        durationMs: llmDuration,
        data: { usage: result.usage, fallback: 'complete' },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const llmDuration = round2(performance.now() - llmStart);
      const errorMsg = err instanceof Error ? err.message : String(err);

      writer.chat({ type: 'error', error: errorMsg });
      writer.trace({
        stage: 'llm',
        status: 'error',
        durationMs: llmDuration,
        data: { error: errorMsg },
        timestamp: new Date().toISOString(),
      });
    }
  } else {
    // Stream from the LLM provider
    try {
      const llmStream = deps.llmProvider.stream(streamRequest);

      for await (const event of llmStream) {
        switch (event.type) {
          case 'delta':
            writer.chat({ type: 'delta', content: event.content });
            break;

          case 'finish':
            fullResponse = event.content;
            writer.chat({
              type: 'finish',
              content: event.content,
              usage: event.usage,
            });
            break;

          case 'error':
            writer.chat({ type: 'error', error: event.error });
            break;
        }
      }

      const llmDuration = round2(performance.now() - llmStart);
      writer.trace({
        stage: 'llm',
        status: 'complete',
        durationMs: llmDuration,
        data: { responseLength: fullResponse.length },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const llmDuration = round2(performance.now() - llmStart);
      const errorMsg = err instanceof Error ? err.message : String(err);

      writer.chat({ type: 'error', error: errorMsg });
      writer.trace({
        stage: 'llm',
        status: 'error',
        durationMs: llmDuration,
        data: { error: errorMsg },
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── Phase 4: Ingestion — Store conversation turn & extract facts ──
  // Supports two modes:
  //   1. IngestionHandler (preferred) — clean interface for the chat endpoint
  //   2. FactExtractor (legacy) — direct fact extraction with EventBus integration
  // If both are provided, ingestionHandler takes precedence.

  const hasIngestionHandler = !!deps.ingestionHandler;
  const hasFactExtractor = !!deps.factExtractor;
  const hasIngestion = hasIngestionHandler || hasFactExtractor;
  let ingestionResult: FactExtractionResult | null = null;
  let ingestionHandlerResult: { factCount: number; facts?: Array<{ content: string }>; error?: string } | null = null;

  if (hasIngestion && fullResponse.length > 0) {
    writer.trace({
      stage: 'ingestion',
      status: 'start',
      data: {
        userMessage: request.message.length > 200 ? request.message.slice(0, 200) : request.message,
        assistantResponseLength: fullResponse.length,
        mode: hasIngestionHandler ? 'handler' : 'factExtractor',
      },
      timestamp: new Date().toISOString(),
    });

    const ingestionStart = performance.now();

    try {
      if (hasIngestionHandler) {
        // ── Mode 1: IngestionHandler (clean interface) ──
        ingestionHandlerResult = await deps.ingestionHandler!.ingest({
          userMessage: request.message,
          assistantMessage: fullResponse,
          sessionId: request.sessionId,
        });

        const ingestionDuration = round2(performance.now() - ingestionStart);

        if (ingestionHandlerResult.error) {
          writer.trace({
            stage: 'ingestion',
            status: 'error',
            durationMs: ingestionDuration,
            data: {
              error: ingestionHandlerResult.error,
              factCount: ingestionHandlerResult.factCount,
            },
            timestamp: new Date().toISOString(),
          });
        } else {
          writer.trace({
            stage: 'ingestion',
            status: 'complete',
            durationMs: ingestionDuration,
            data: {
              factCount: ingestionHandlerResult.factCount,
              facts: ingestionHandlerResult.facts,
            },
            timestamp: new Date().toISOString(),
          });
        }
      } else {
        // ── Mode 2: FactExtractor (legacy, with EventBus) ──
        const conversationId = deps.conversationId ?? `debug-chat-${uuidv4()}`;

        const extractionInput: FactExtractionInput = {
          conversationId,
          userMessage: {
            content: request.message,
            turnIndex: (request.history?.length ?? 0),
          },
          assistantMessage: {
            content: fullResponse,
            turnIndex: (request.history?.length ?? 0) + 1,
          },
          priorContext: request.history && request.history.length > 0
            ? request.history
                .slice(-6)
                .map(m => `[${m.role}]: ${m.content}`)
                .join('\n\n')
            : undefined,
        };

        ingestionResult = await deps.factExtractor!.extractFromTurn(extractionInput);
        const ingestionDuration = round2(performance.now() - ingestionStart);

        if (ingestionResult.ok) {
          // Save extracted facts to DB for future recall
          if (deps.factRepo && ingestionResult.facts.length > 0) {
            try {
              // Ensure conversation exists in memory DB (FK requirement for facts table)
              let persistedConvId = conversationId;
              if (deps.ingestService) {
                try {
                  const conv = deps.ingestService.ingestConversation({
                    source: 'debug-chat',
                    id: conversationId,
                    messages: [
                      { role: 'user', content: request.message },
                      { role: 'assistant', content: fullResponse },
                    ],
                  });
                  persistedConvId = conv.id;
                } catch {
                  // Conversation may already exist — that's fine
                }
              }

              deps.factRepo.createMany(
                ingestionResult.facts.map(f => ({
                  conversationId: persistedConvId,
                  sourceMessageIds: [`${persistedConvId}:${extractionInput.userMessage.turnIndex}`, `${persistedConvId}:${extractionInput.assistantMessage.turnIndex}`],
                  sourceTurnIndex: extractionInput.userMessage.turnIndex,
                  content: f.content,
                  category: f.category ?? 'general',
                  confidence: f.confidence ?? 0.8,
                  entities: f.entities ?? [],
                  subject: f.subject,
                  predicate: f.predicate,
                  object: f.object,
                })),
              );
            } catch (saveErr) {
              console.error('[chat-router] Failed to save facts:', saveErr);
            }
          }

          if (deps.eventBus && ingestionResult.facts.length > 0) {
            void deps.eventBus.emit({
              type: 'facts.extracted' as const,
              conversationId,
              sourceTurnIndex: extractionInput.assistantMessage.turnIndex,
              facts: ingestionResult.facts,
              timestamp: new Date().toISOString(),
            });
          }

          writer.trace({
            stage: 'ingestion',
            status: 'complete',
            durationMs: ingestionDuration,
            data: {
              factCount: ingestionResult.facts.length,
              facts: ingestionResult.facts.map(f => ({
                id: f.id,
                content: f.content,
                category: f.category,
                confidence: f.confidence,
                entities: f.entities,
                subject: f.subject,
                predicate: f.predicate,
                object: f.object,
              })),
              rawResponse: ingestionResult.rawResponse,
            },
            timestamp: new Date().toISOString(),
          });
        } else {
          if (deps.eventBus) {
            void deps.eventBus.emit({
              type: 'extraction.error' as const,
              conversationId,
              sourceTurnIndex: extractionInput.assistantMessage.turnIndex,
              error: ingestionResult.error ?? 'Unknown extraction error',
              timestamp: new Date().toISOString(),
            });
          }

          writer.trace({
            stage: 'ingestion',
            status: 'error',
            durationMs: ingestionDuration,
            data: {
              error: ingestionResult.error ?? 'Unknown extraction error',
              rawResponse: ingestionResult.rawResponse,
            },
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      const ingestionDuration = round2(performance.now() - ingestionStart);
      const errorMsg = err instanceof Error ? err.message : String(err);

      writer.trace({
        stage: 'ingestion',
        status: 'error',
        durationMs: ingestionDuration,
        data: { error: errorMsg },
        timestamp: new Date().toISOString(),
      });
    }
  } else if (!hasIngestion) {
    writer.trace({
      stage: 'ingestion',
      status: 'skipped',
      data: { reason: 'No fact extractor configured' },
      timestamp: new Date().toISOString(),
    });
  } else {
    // fullResponse is empty (LLM error) — skip ingestion
    writer.trace({
      stage: 'ingestion',
      status: 'skipped',
      data: { reason: 'Empty response — no facts to extract' },
      timestamp: new Date().toISOString(),
    });
  }

  // ── Phase 5: Pipeline complete ──

  const totalDuration = round2(performance.now() - pipelineStart);

  writer.trace({
    stage: 'pipeline',
    status: 'complete',
    durationMs: totalDuration,
    data: {
      userId: DEBUG_USER_ID,
      responseLength: fullResponse.length,
      memoryItemCount: recallResult?.items.length ?? unifiedResult?.items.length ?? 0,
      recallMode: unifiedResult ? 'unified' : recallResult ? 'dual-path' : 'none',
      factCount: ingestionResult?.facts.length ?? ingestionHandlerResult?.factCount ?? 0,
      stages: writer.getCollector().getStageSummary(),
    },
    timestamp: new Date().toISOString(),
  });

  // Send terminal done event (includes all collected trace events for timeline)
  writer.done(fullResponse, totalDuration);

  return {
    fullResponse,
    totalDurationMs: totalDuration,
    model: request.model,
  };
}

// ─── Router Factory ───────────────────────────────────────

/**
 * Create the Hono chat router with SSE streaming support.
 *
 * The router provides:
 *   POST /chat  — Main streaming chat endpoint
 *   GET  /chat/health — Health check for chat subsystem
 *
 * @param deps - Injectable dependencies (LLM provider, retriever)
 * @returns Hono app instance with /chat routes
 */
export function createChatRouter(deps: ChatRouterDependencies): Hono {
  const app = new Hono();

  // ── POST /chat — SSE streaming chat endpoint ──
  app.post('/chat', async (c) => {
    // Parse and validate request body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      const err: ChatValidationError = {
        error: 'INVALID_JSON',
        message: 'Request body must be valid JSON',
      };
      return c.json(err, 400);
    }

    const errors = validateChatRequest(body);
    if (errors.length > 0) {
      const err: ChatValidationError = {
        error: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: errors,
      };
      return c.json(err, 400);
    }

    const request = body as ChatRequest;

    // Create SSE ReadableStream
    const chatDb = deps.chatDb;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const collector = new TraceCollector();
        const writer = new SSEWriter(controller, collector);

        // Run the pipeline asynchronously
        executePipeline(writer, request, deps)
          .then((result) => {
            // Persist conversation, messages, and trace events to SQLite
            if (chatDb && result.fullResponse.length > 0) {
              try {
                const conversation = getOrCreateConversation(chatDb, {
                  conversationId: request.sessionId,
                  sessionId: request.sessionId,
                  userId: DEBUG_USER_ID,
                });

                const turnResult = saveChatTurn(chatDb, {
                  conversationId: conversation.id,
                  userMessage: request.message,
                  assistantMessage: result.fullResponse,
                  model: result.model,
                  durationMs: result.totalDurationMs,
                });

                // Persist trace events for the assistant message
                const traceEvents = collector.getAll();
                if (traceEvents.length > 0) {
                  savePipelineTraceEvents(
                    chatDb,
                    conversation.id,
                    turnResult.assistantMessageId,
                    traceEvents,
                  );
                }
              } catch (dbErr) {
                console.error('[chat-router] Failed to persist chat turn:', dbErr);
              }
            }
          })
          .catch((err) => {
            console.error('[chat-router] Pipeline error:', err);
            try {
              const errorMsg = err instanceof Error ? err.message : String(err);
              writer.chat({ type: 'error', error: errorMsg });
              writer.writeEvent('done', '[DONE]');
              writer.close();
            } catch {
              // Stream may already be closed
            }
          });
      },
    });

    // Return SSE response with proper headers
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  // ── GET /chat/health — health check for chat subsystem ──
  app.get('/chat/health', (c) => {
    return c.json({
      status: 'ok',
      subsystem: 'chat',
      provider: deps.llmProvider.name,
      hasRetriever: !!deps.retriever,
      hasUnifiedRetriever: !!deps.unifiedRetriever,
      userId: DEBUG_USER_ID,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

// ─── Utility ──────────────────────────────────────────────

function round2(ms: number): number {
  return Math.round(ms * 100) / 100;
}
