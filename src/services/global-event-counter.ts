/**
 * Global Event Counter — event-based monotonic counter for lazy decay evaluation.
 *
 * Replaces the old time-based DecayScheduler with an event-driven approach.
 * The counter is stored in the `system_state` KV table under the key
 * `global_event_counter` and incremented on specific events:
 *
 *   - turn.completed  → +1.0  (full turn is a major event)
 *   - retrieval.completed → +0.3  (retrieval is a minor event)
 *
 * The counter value is used as the "event clock" for shield+weight decay:
 * rather than decaying based on wall-clock time, edges and nodes decay
 * based on how many events have elapsed since their last activation.
 *
 * Usage:
 *   const counter = new GlobalEventCounter(db, eventBus);
 *   counter.start();  // Subscribe to events
 *   // ... later ...
 *   const current = counter.current();  // Read current counter value
 *   counter.stop();   // Unsubscribe
 */

import type Database from 'better-sqlite3';
import type { EventBus } from '../events/event-bus.js';
import { SystemStateRepository } from '../db/system-state-repo.js';
import { CREATE_SYSTEM_STATE_TABLE } from '../db/system-state-schema.js';

/** Key used in system_state table for the global event counter */
export const GLOBAL_EVENT_COUNTER_KEY = 'global_event_counter';

/** Increment amounts for each event type */
export const EVENT_INCREMENTS = {
  'turn.completed': 1.0,
  'retrieval.completed': 0.3,
} as const;

export type CounterEventType = keyof typeof EVENT_INCREMENTS;

export interface GlobalEventCounterOptions {
  /** Custom increment values (overrides defaults) */
  increments?: Partial<Record<CounterEventType, number>>;
}

export class GlobalEventCounter {
  private repo: SystemStateRepository;
  private unsubscribers: Array<() => void> = [];
  private increments: Record<CounterEventType, number>;

  constructor(
    private db: Database.Database,
    private eventBus: EventBus,
    options?: GlobalEventCounterOptions,
  ) {
    // Ensure system_state table exists
    db.exec(CREATE_SYSTEM_STATE_TABLE);

    this.repo = new SystemStateRepository(db);
    this.increments = {
      ...EVENT_INCREMENTS,
      ...options?.increments,
    };
  }

  /**
   * Subscribe to EventBus events and start incrementing the counter.
   */
  start(): void {
    // Subscribe to turn.completed
    const unsubTurn = this.eventBus.on('turn.completed', () => {
      this.increment('turn.completed');
    });
    this.unsubscribers.push(unsubTurn);

    // Subscribe to retrieval.completed
    const unsubRetrieval = this.eventBus.on('retrieval.completed', () => {
      this.increment('retrieval.completed');
    });
    this.unsubscribers.push(unsubRetrieval);
  }

  /**
   * Unsubscribe from all events.
   */
  stop(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  /**
   * Get the current global event counter value.
   * Returns 0.0 if counter has never been incremented.
   */
  current(): number {
    return this.repo.getNumber(GLOBAL_EVENT_COUNTER_KEY);
  }

  /**
   * Manually increment the counter by a specific event type's delta.
   * Returns the new counter value after increment.
   */
  increment(eventType: CounterEventType): number {
    const delta = this.increments[eventType];
    return this.repo.increment(GLOBAL_EVENT_COUNTER_KEY, delta);
  }

  /**
   * Manually increment the counter by an arbitrary delta.
   * Returns the new counter value after increment.
   */
  incrementBy(delta: number): number {
    return this.repo.increment(GLOBAL_EVENT_COUNTER_KEY, delta);
  }

  /**
   * Reset the counter to 0. Useful for testing.
   */
  reset(): void {
    this.repo.setNumber(GLOBAL_EVENT_COUNTER_KEY, 0);
  }

  /**
   * Get the underlying repository for direct KV access.
   */
  getRepository(): SystemStateRepository {
    return this.repo;
  }
}
