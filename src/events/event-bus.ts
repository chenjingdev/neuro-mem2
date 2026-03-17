/**
 * Simple typed EventBus for decoupling session lifecycle from batch processing
 * and turn-level real-time extraction.
 *
 * Events flow:
 *   IngestService -> EventBus (turn.completed) -> ExtractionPipeline
 *   SessionManager -> EventBus (session.ended) -> BatchPipeline
 */

import type { RawMessage } from '../models/conversation.js';
import type { Fact } from '../models/fact.js';

/** Emitted when a conversation turn (message append) completes */
export interface TurnCompletedEvent {
  type: 'turn.completed';
  conversationId: string;
  message: RawMessage;
  timestamp: string;
}

/** Emitted after facts are successfully extracted from a turn */
export interface FactsExtractedEvent {
  type: 'facts.extracted';
  conversationId: string;
  sourceMessageId: string;
  facts: Fact[];
  timestamp: string;
}

/** Emitted when fact extraction fails for a turn */
export interface ExtractionErrorEvent {
  type: 'extraction.error';
  conversationId: string;
  sourceMessageId: string;
  error: string;
  timestamp: string;
}

export interface SessionEndedEvent {
  type: 'session.ended';
  sessionId: string;
  conversationId: string;
  reason: string;
  timestamp: string;
}

export interface BatchJobCreatedEvent {
  type: 'batch.job.created';
  jobId: string;
  sessionId: string;
  conversationId: string;
  jobType: string;
  timestamp: string;
}

export interface BatchJobCompletedEvent {
  type: 'batch.job.completed';
  jobId: string;
  sessionId: string;
  jobType: string;
  timestamp: string;
}

export interface BatchJobFailedEvent {
  type: 'batch.job.failed';
  jobId: string;
  sessionId: string;
  jobType: string;
  error: string;
  timestamp: string;
}

/** Emitted after a successful decay cycle */
export interface DecayCompletedEvent {
  type: 'decay.completed';
  decayedCount: number;
  prunedCount: number;
  durationMs: number;
  timestamp: string;
}

/** Emitted when a decay cycle fails */
export interface DecayErrorEvent {
  type: 'decay.error';
  error: string;
  timestamp: string;
}

export type MemoryEvent =
  | TurnCompletedEvent
  | FactsExtractedEvent
  | ExtractionErrorEvent
  | SessionEndedEvent
  | BatchJobCreatedEvent
  | BatchJobCompletedEvent
  | BatchJobFailedEvent
  | DecayCompletedEvent
  | DecayErrorEvent;

export type EventHandler<T extends MemoryEvent = MemoryEvent> = (event: T) => void | Promise<void>;

type EventType = MemoryEvent['type'];

export class EventBus {
  private handlers = new Map<EventType, Set<EventHandler<any>>>();
  private allHandlers = new Set<EventHandler<MemoryEvent>>();

  /**
   * Subscribe to a specific event type.
   * Returns an unsubscribe function.
   */
  on<T extends MemoryEvent>(type: T['type'], handler: EventHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /**
   * Subscribe to all events.
   * Returns an unsubscribe function.
   */
  onAll(handler: EventHandler<MemoryEvent>): () => void {
    this.allHandlers.add(handler);
    return () => {
      this.allHandlers.delete(handler);
    };
  }

  /**
   * Emit an event to all matching handlers.
   * Handlers are called asynchronously but errors are caught and logged.
   */
  async emit<T extends MemoryEvent>(event: T): Promise<void> {
    const typeHandlers = this.handlers.get(event.type);
    const promises: Promise<void>[] = [];

    if (typeHandlers) {
      for (const handler of typeHandlers) {
        promises.push(
          (async () => { await handler(event); })().catch((err) => {
            console.error(`EventBus handler error for ${event.type}:`, err);
          })
        );
      }
    }

    for (const handler of this.allHandlers) {
      promises.push(
        (async () => { await handler(event); })().catch((err) => {
          console.error(`EventBus global handler error for ${event.type}:`, err);
        })
      );
    }

    await Promise.all(promises);
  }

  /**
   * Remove all handlers. Useful for cleanup in tests.
   */
  clear(): void {
    this.handlers.clear();
    this.allHandlers.clear();
  }
}
