/**
 * TraceCollector — collects TraceEvent objects during recall pipeline execution.
 *
 * Usage patterns:
 *
 *   // 1. Create a collector
 *   const collector = new TraceCollector();
 *
 *   // 2. Optionally subscribe to events in real-time (e.g. SSE streaming)
 *   collector.onEvent((event) => sseWriter.trace(event));
 *
 *   // 3. Instrument pipeline stages
 *   collector.start('vector_search', { queryText }, 'recall');
 *   // ... do work ...
 *   collector.complete('vector_search', { itemCount: 5 }, durationMs);
 *
 *   // 4. Or use the convenient `wrapAsync` helper
 *   const result = await collector.wrapAsync('vector_search', { queryText }, async () => {
 *     return await vectorSearcher.search(query);
 *   }, 'recall');
 *
 *   // 5. Read collected events
 *   const events = collector.getEvents();
 *   const timeline = collector.getTimeline();
 */

import type {
  TraceStage,
  TraceStatus,
  TraceEvent,
  TraceEventListener,
} from './trace-types.js';

// ─── TraceCollector ────────────────────────────────────────

export class TraceCollector {
  /** All collected events, in emission order. */
  private events: TraceEvent[] = [];

  /** Monotonic counter for event IDs. */
  private nextId = 1;

  /** Registered real-time listeners. */
  private listeners: Set<TraceEventListener> = new Set();

  /** Pending start timestamps for duration calculation. */
  private startTimes: Map<TraceStage, number> = new Map();

  // ─── Event emission ───────────────────────────────────

  /**
   * Emit a 'start' event for a pipeline stage.
   *
   * @param stage - Pipeline stage name
   * @param input - Stage input data
   * @param parentStage - Optional parent stage for nesting
   */
  start(stage: TraceStage, input?: unknown, parentStage?: TraceStage): TraceEvent {
    this.startTimes.set(stage, performance.now());

    const event: TraceEvent = {
      id: this.nextId++,
      stage,
      status: 'start',
      input,
      timestamp: new Date().toISOString(),
      parentStage,
    };

    return this.emit(event);
  }

  /**
   * Emit a 'complete' event for a pipeline stage.
   *
   * If a matching start() was called, durationMs is computed automatically.
   * You can also pass an explicit durationMs to override.
   *
   * @param stage - Pipeline stage name
   * @param output - Stage output data
   * @param durationMs - Optional explicit duration (otherwise auto-computed from start)
   * @param parentStage - Optional parent stage for nesting
   */
  complete(
    stage: TraceStage,
    output?: unknown,
    durationMs?: number,
    parentStage?: TraceStage,
  ): TraceEvent {
    const duration = durationMs ?? this.computeDuration(stage);

    const event: TraceEvent = {
      id: this.nextId++,
      stage,
      status: 'complete',
      output,
      durationMs: duration !== undefined ? round2(duration) : undefined,
      timestamp: new Date().toISOString(),
      parentStage,
    };

    this.startTimes.delete(stage);
    return this.emit(event);
  }

  /**
   * Emit an 'error' event for a pipeline stage.
   *
   * @param stage - Pipeline stage name
   * @param error - Error message or Error object
   * @param durationMs - Optional explicit duration
   * @param parentStage - Optional parent stage for nesting
   */
  error(
    stage: TraceStage,
    error: string | Error,
    durationMs?: number,
    parentStage?: TraceStage,
  ): TraceEvent {
    const duration = durationMs ?? this.computeDuration(stage);
    const errorMsg = error instanceof Error ? error.message : error;

    const event: TraceEvent = {
      id: this.nextId++,
      stage,
      status: 'error',
      error: errorMsg,
      durationMs: duration !== undefined ? round2(duration) : undefined,
      timestamp: new Date().toISOString(),
      parentStage,
    };

    this.startTimes.delete(stage);
    return this.emit(event);
  }

  /**
   * Emit a 'skipped' event for a pipeline stage.
   *
   * @param stage - Pipeline stage name
   * @param reason - Why the stage was skipped
   * @param parentStage - Optional parent stage for nesting
   */
  skipped(stage: TraceStage, reason: string, parentStage?: TraceStage): TraceEvent {
    const event: TraceEvent = {
      id: this.nextId++,
      stage,
      status: 'skipped',
      skipReason: reason,
      timestamp: new Date().toISOString(),
      parentStage,
    };

    return this.emit(event);
  }

  // ─── Convenience: wrap an async function ──────────────

  /**
   * Wrap an async function with start/complete/error tracing.
   *
   * Automatically emits start, then complete or error events.
   * Returns the function's result.
   *
   * @param stage - Pipeline stage name
   * @param input - Stage input data (emitted with 'start')
   * @param fn - Async function to execute
   * @param parentStage - Optional parent stage
   * @returns The function's return value
   */
  async wrapAsync<T>(
    stage: TraceStage,
    input: unknown,
    fn: () => Promise<T>,
    parentStage?: TraceStage,
  ): Promise<T> {
    this.start(stage, input, parentStage);
    const startTime = performance.now();

    try {
      const result = await fn();
      const duration = performance.now() - startTime;
      this.complete(stage, undefined, duration, parentStage);
      return result;
    } catch (err) {
      const duration = performance.now() - startTime;
      this.error(stage, err instanceof Error ? err : String(err), duration, parentStage);
      throw err;
    }
  }

  /**
   * Wrap a sync function with start/complete/error tracing.
   *
   * @param stage - Pipeline stage name
   * @param input - Stage input data
   * @param fn - Sync function to execute
   * @param parentStage - Optional parent stage
   * @returns The function's return value
   */
  wrapSync<T>(
    stage: TraceStage,
    input: unknown,
    fn: () => T,
    parentStage?: TraceStage,
  ): T {
    this.start(stage, input, parentStage);
    const startTime = performance.now();

    try {
      const result = fn();
      const duration = performance.now() - startTime;
      this.complete(stage, undefined, duration, parentStage);
      return result;
    } catch (err) {
      const duration = performance.now() - startTime;
      this.error(stage, err instanceof Error ? err : String(err), duration, parentStage);
      throw err;
    }
  }

  // ─── Listener management ──────────────────────────────

  /**
   * Register a listener that is called for every emitted event.
   * Returns an unsubscribe function.
   */
  onEvent(listener: TraceEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ─── Queries ──────────────────────────────────────────

  /** Get all collected events in emission order. */
  getEvents(): ReadonlyArray<TraceEvent> {
    return this.events;
  }

  /** Get events for a specific stage. */
  getStageEvents(stage: TraceStage): ReadonlyArray<TraceEvent> {
    return this.events.filter(e => e.stage === stage);
  }

  /** Get the 'complete' event for a stage (if any). */
  getStageResult(stage: TraceStage): TraceEvent | undefined {
    return this.events.find(e => e.stage === stage && e.status === 'complete');
  }

  /**
   * Get a timeline summary: for each stage that completed,
   * return the stage name, duration, and status.
   */
  getTimeline(): Array<{
    stage: TraceStage;
    status: TraceStatus;
    durationMs?: number;
    parentStage?: TraceStage;
  }> {
    // Collect the terminal event for each stage (complete, error, or skipped)
    const seen = new Map<TraceStage, TraceEvent>();
    for (const event of this.events) {
      if (event.status !== 'start') {
        seen.set(event.stage, event);
      }
    }

    return Array.from(seen.values()).map(e => ({
      stage: e.stage,
      status: e.status,
      durationMs: e.durationMs,
      parentStage: e.parentStage,
    }));
  }

  /** Total number of collected events. */
  get size(): number {
    return this.events.length;
  }

  /** Reset the collector, clearing all events and start times. */
  clear(): void {
    this.events = [];
    this.startTimes.clear();
    this.nextId = 1;
  }

  // ─── Internal ─────────────────────────────────────────

  private emit(event: TraceEvent): TraceEvent {
    this.events.push(event);

    // Notify listeners (fire-and-forget, errors logged)
    for (const listener of this.listeners) {
      try {
        const result = listener(event);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => {
            console.error('[TraceCollector] Listener error:', err);
          });
        }
      } catch (err) {
        console.error('[TraceCollector] Listener error:', err);
      }
    }

    return event;
  }

  private computeDuration(stage: TraceStage): number | undefined {
    const startTime = this.startTimes.get(stage);
    if (startTime === undefined) return undefined;
    return performance.now() - startTime;
  }
}

// ─── Utility ───────────────────────────────────────────────

function round2(ms: number): number {
  return Math.round(ms * 100) / 100;
}
