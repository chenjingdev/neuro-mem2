/**
 * Memory Node Extraction Pipeline — replaces the old TurnExtractionPipeline
 * with unified MemoryNodeExtractor (single LLM call per turn).
 *
 * Flow:
 *   1. IngestService appends a message -> emits 'turn.completed'
 *   2. Pipeline receives the event
 *   3. Gathers the user+assistant message pair (a "turn")
 *   4. Calls MemoryNodeExtractor.extractFromTurn() — single LLM call
 *   5. Saves extracted MemoryNodes to MemoryNodeRepository
 *   6. Emits 'memory-nodes.extracted' or 'extraction.error'
 *
 * Key design:
 * - Single LLM call per turn extracts ALL nodeTypes (1-call/turn budget)
 * - searchKeywords -> L0 keywords (FTS5-indexed, 한영 혼용)
 * - relatedEntities -> L1 metadata.entities + hub matching candidates
 * - Event-based lifecycle via GlobalEventCounter
 */

import type {
  EventBus,
  TurnCompletedEvent,
} from '../events/event-bus.js';
import type { MemoryNodeExtractor } from '../extraction/memory-node-extractor.js';
import type { MemoryNodeRepository } from '../db/memory-node-repo.js';
import type { ConversationRepository } from '../db/conversation-repo.js';
import type { MemoryNodeExtractionInput } from '../extraction/memory-node-prompt.js';
import type { GlobalEventCounter } from '../services/global-event-counter.js';
import type { MemoryNode } from '../models/memory-node.js';

// ─── Pipeline Options ──────────────────────────────────────────

export interface MemoryNodeExtractionPipelineOptions {
  /** Number of prior messages to include as context (default: 6) */
  contextWindowSize?: number;
  /** If true, pipeline listens for events automatically on start() */
  autoStart?: boolean;
}

// ─── Pipeline Result (for testing/monitoring) ──────────────────

export interface PipelineExtractionResult {
  ok: boolean;
  nodesCreated: number;
  nodeIds: string[];
  nodeTypes: string[];
  error?: string;
}

// ─── Pipeline ──────────────────────────────────────────────────

export class MemoryNodeExtractionPipeline {
  private readonly contextWindowSize: number;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private eventBus: EventBus,
    private extractor: MemoryNodeExtractor,
    private nodeRepo: MemoryNodeRepository,
    private conversationRepo: ConversationRepository,
    private globalCounter?: GlobalEventCounter,
    options: MemoryNodeExtractionPipelineOptions = {},
  ) {
    this.contextWindowSize = options.contextWindowSize ?? 6;
  }

  /**
   * Start listening for turn.completed events and extracting memory nodes.
   */
  start(): void {
    if (this.unsubscribe) return; // Already started

    this.unsubscribe = this.eventBus.on<TurnCompletedEvent>(
      'turn.completed',
      (event) => { this.handleTurnCompleted(event); },
    );
  }

  /**
   * Stop listening for turn events.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Handle a turn completion event.
   * Only processes assistant messages (which complete a user->assistant turn).
   */
  async handleTurnCompleted(event: TurnCompletedEvent): Promise<PipelineExtractionResult> {
    const { conversationId, message } = event;

    // Only extract on assistant messages — they complete a turn
    if (message.role !== 'assistant') {
      return { ok: true, nodesCreated: 0, nodeIds: [], nodeTypes: [] };
    }

    // Find the preceding user message to form a complete turn
    const messages = this.conversationRepo.getMessages(conversationId);
    const userMessage = this.findPrecedingUserMessage(messages, message.turnIndex);

    if (!userMessage) {
      // No preceding user message — skip extraction
      return { ok: true, nodesCreated: 0, nodeIds: [], nodeTypes: [] };
    }

    // Build prior context from earlier messages
    const priorContext = this.buildPriorContext(messages, message.turnIndex);

    // Get current event counter for node lifecycle tracking
    const currentEventCounter = this.globalCounter?.current() ?? 0;

    const extractionInput: MemoryNodeExtractionInput = {
      conversationId,
      userMessage: {
        content: userMessage.content,
        turnIndex: userMessage.turnIndex,
      },
      assistantMessage: {
        content: message.content,
        turnIndex: message.turnIndex,
      },
      priorContext: priorContext || undefined,
    };

    try {
      // Single LLM call extracts ALL nodeTypes
      const result = await this.extractor.extractFromTurn(extractionInput, currentEventCounter);

      if (result.ok && result.createInputs.length > 0) {
        // Save all extracted nodes to the repository
        const savedNodes: MemoryNode[] = this.nodeRepo.createBatch(result.createInputs);

        const nodeIds = savedNodes.map((n) => n.id);
        const nodeTypes = savedNodes.map((n) => n.nodeType ?? 'null');

        // Emit success event
        await this.eventBus.emit({
          type: 'memory-nodes.extracted' as const,
          conversationId,
          sourceTurnIndex: message.turnIndex,
          nodeCount: savedNodes.length,
          nodeIds,
          nodeTypes,
          timestamp: new Date().toISOString(),
        });

        return {
          ok: true,
          nodesCreated: savedNodes.length,
          nodeIds,
          nodeTypes,
        };
      } else if (!result.ok) {
        // Emit error event
        await this.eventBus.emit({
          type: 'extraction.error' as const,
          conversationId,
          sourceTurnIndex: message.turnIndex,
          error: result.error ?? 'Unknown extraction error',
          timestamp: new Date().toISOString(),
        });

        return {
          ok: false,
          nodesCreated: 0,
          nodeIds: [],
          nodeTypes: [],
          error: result.error,
        };
      }

      // ok but no nodes — that's fine
      return { ok: true, nodesCreated: 0, nodeIds: [], nodeTypes: [] };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      await this.eventBus.emit({
        type: 'extraction.error' as const,
        conversationId,
        sourceTurnIndex: message.turnIndex,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });

      return {
        ok: false,
        nodesCreated: 0,
        nodeIds: [],
        nodeTypes: [],
        error: errorMessage,
      };
    }
  }

  /**
   * Find the user message immediately preceding the given turn index.
   */
  private findPrecedingUserMessage(
    messages: Array<{ role: string; content: string; turnIndex: number }>,
    assistantTurnIndex: number,
  ) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.turnIndex < assistantTurnIndex && msg.role === 'user') {
        return msg;
      }
    }
    return null;
  }

  /**
   * Build prior context string from messages before the current turn.
   */
  private buildPriorContext(
    messages: Array<{ role: string; content: string; turnIndex: number }>,
    currentTurnIndex: number,
  ): string {
    const priorMessages = messages
      .filter((m) => m.turnIndex < currentTurnIndex - 1)
      .slice(-this.contextWindowSize);

    if (priorMessages.length === 0) return '';

    return priorMessages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n\n');
  }
}
