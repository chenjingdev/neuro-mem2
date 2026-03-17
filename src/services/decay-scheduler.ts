/**
 * DecayScheduler — periodic background process that applies time-based
 * Hebbian weight decay to all weighted edges in the retrieval graph.
 *
 * Runs on a configurable interval (default: 1 hour) and applies the
 * decay formula: w_new = w_old * (1 - decay_rate) for each edge.
 * Edges whose weight falls below a configurable prune threshold are deleted.
 *
 * Emits events via EventBus for observability:
 *   - 'decay.completed' after successful decay cycle
 *   - 'decay.error' if a decay cycle fails
 */

import type { WeightedEdgeRepository } from '../db/weighted-edge-repo.js';
import type { EventBus, DecayCompletedEvent, DecayErrorEvent } from '../events/event-bus.js';

export type { DecayCompletedEvent, DecayErrorEvent } from '../events/event-bus.js';
export type DecayEvent = DecayCompletedEvent | DecayErrorEvent;

// ─── Configuration ───────────────────────────────────────────────

/** Default interval: 1 hour in milliseconds */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/** Default prune threshold: edges below this weight are deleted */
const DEFAULT_PRUNE_BELOW = 0.01;

export interface DecaySchedulerOptions {
  /** Interval between decay cycles in milliseconds (default: 3600000 = 1 hour) */
  intervalMs?: number;
  /** Delete edges whose weight falls below this threshold after decay (default: 0.01) */
  pruneBelow?: number;
  /** If true, run an immediate decay cycle on start (default: false) */
  runOnStart?: boolean;
}

// ─── Decay Result ────────────────────────────────────────────────

export interface DecayCycleResult {
  decayedCount: number;
  prunedCount: number;
  durationMs: number;
  timestamp: string;
}

// ─── Scheduler Class ─────────────────────────────────────────────

export class DecayScheduler {
  private readonly intervalMs: number;
  private readonly pruneBelow: number;
  private readonly runOnStart: boolean;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cycleInProgress = false;
  private lastResult: DecayCycleResult | null = null;
  private totalCycles = 0;

  constructor(
    private readonly weightedEdgeRepo: WeightedEdgeRepository,
    private readonly eventBus: EventBus | null = null,
    options?: DecaySchedulerOptions,
  ) {
    this.intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.pruneBelow = options?.pruneBelow ?? DEFAULT_PRUNE_BELOW;
    this.runOnStart = options?.runOnStart ?? false;

    if (this.intervalMs <= 0) {
      throw new Error('DecayScheduler intervalMs must be positive');
    }
  }

  // ── Lifecycle ──

  /**
   * Start the periodic decay scheduler.
   * If already running, this is a no-op.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    if (this.runOnStart) {
      // Fire-and-forget the initial cycle
      this.executeCycle().catch(() => {
        // Errors are emitted via eventBus, no need to rethrow
      });
    }

    this.timer = setInterval(() => {
      this.executeCycle().catch(() => {
        // Errors are emitted via eventBus
      });
    }, this.intervalMs);

    // Allow Node.js process to exit even if timer is running
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  /**
   * Stop the periodic decay scheduler.
   * If not running, this is a no-op.
   * Does NOT interrupt an in-progress cycle.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Whether the scheduler is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Whether a decay cycle is currently in progress.
   */
  isCycleInProgress(): boolean {
    return this.cycleInProgress;
  }

  /**
   * Get the result of the most recent decay cycle, or null if none has run.
   */
  getLastResult(): DecayCycleResult | null {
    return this.lastResult;
  }

  /**
   * Get the total number of completed decay cycles since the scheduler was created.
   */
  getTotalCycles(): number {
    return this.totalCycles;
  }

  /**
   * Execute a single decay cycle manually (useful for testing or on-demand decay).
   * This can be called regardless of whether the scheduler is running.
   *
   * If a cycle is already in progress, returns the promise of the ongoing cycle.
   */
  async executeCycle(): Promise<DecayCycleResult> {
    if (this.cycleInProgress) {
      // Return last result or a zero-result if no previous cycle
      return this.lastResult ?? {
        decayedCount: 0,
        prunedCount: 0,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      };
    }

    this.cycleInProgress = true;
    const startTime = Date.now();

    try {
      const { decayedCount, prunedCount } = this.weightedEdgeRepo.applyDecay({
        pruneBelow: this.pruneBelow,
      });

      const durationMs = Date.now() - startTime;
      const timestamp = new Date().toISOString();

      const result: DecayCycleResult = {
        decayedCount,
        prunedCount,
        durationMs,
        timestamp,
      };

      this.lastResult = result;
      this.totalCycles++;

      // Emit completion event
      if (this.eventBus) {
        await this.eventBus.emit({
          type: 'decay.completed',
          decayedCount,
          prunedCount,
          durationMs,
          timestamp,
        } as DecayCompletedEvent);
      }

      return result;
    } catch (err) {
      const timestamp = new Date().toISOString();
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Emit error event
      if (this.eventBus) {
        await this.eventBus.emit({
          type: 'decay.error',
          error: errorMessage,
          timestamp,
        } as DecayErrorEvent);
      }

      throw err;
    } finally {
      this.cycleInProgress = false;
    }
  }

  /**
   * Dispose of the scheduler, stopping it and clearing state.
   */
  dispose(): void {
    this.stop();
    this.lastResult = null;
    this.totalCycles = 0;
  }
}
