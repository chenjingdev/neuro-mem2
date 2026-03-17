/**
 * Turn Extraction Pipeline — connects conversation turn events to
 * real-time fact extraction and storage.
 *
 * Flow:
 *   1. IngestService appends a message → emits 'turn.completed'
 *   2. Pipeline receives the event
 *   3. Gathers the user+assistant message pair (a "turn")
 *   4. Calls FactExtractor to extract facts via LLM
 *   5. Saves extracted facts to FactRepository
 *   6. Emits 'facts.extracted' or 'extraction.error'
 *
 * Design decisions:
 * - Only triggers on assistant messages (a complete turn = user + assistant)
 * - Extraction is async and non-blocking to the message append path
 * - Errors are caught and emitted as events, never crash the pipeline
 */

import type { EventBus, TurnCompletedEvent } from '../events/event-bus.js';
import type { FactExtractor } from '../extraction/fact-extractor.js';
import type { FactRepository } from '../db/fact-repo.js';
import type { ConversationRepository } from '../db/conversation-repo.js';
import type { FactExtractionInput, CreateFactInput } from '../models/fact.js';

export interface TurnExtractionPipelineOptions {
  /** Number of prior messages to include as context (default: 6) */
  contextWindowSize?: number;
}

export class TurnExtractionPipeline {
  private readonly contextWindowSize: number;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private eventBus: EventBus,
    private factExtractor: FactExtractor,
    private factRepo: FactRepository,
    private conversationRepo: ConversationRepository,
    options: TurnExtractionPipelineOptions = {},
  ) {
    this.contextWindowSize = options.contextWindowSize ?? 6;
  }

  /**
   * Start listening for turn events and processing them.
   */
  start(): void {
    if (this.unsubscribe) return; // Already started

    this.unsubscribe = this.eventBus.on<TurnCompletedEvent>(
      'turn.completed',
      (event) => this.handleTurnCompleted(event),
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
   * Only processes assistant messages (which complete a user→assistant turn).
   */
  async handleTurnCompleted(event: TurnCompletedEvent): Promise<void> {
    const { conversationId, message } = event;

    // Only extract on assistant messages — they complete a turn
    if (message.role !== 'assistant') {
      return;
    }

    // Find the preceding user message to form a complete turn
    const messages = this.conversationRepo.getMessages(conversationId);
    const userMessage = this.findPrecedingUserMessage(messages, message.turnIndex);

    if (!userMessage) {
      // No preceding user message — skip extraction
      return;
    }

    // Build prior context from earlier messages
    const priorContext = this.buildPriorContext(messages, message.turnIndex);

    const extractionInput: FactExtractionInput = {
      conversationId,
      userMessage: {
        id: userMessage.id,
        content: userMessage.content,
        turnIndex: userMessage.turnIndex,
      },
      assistantMessage: {
        id: message.id,
        content: message.content,
        turnIndex: message.turnIndex,
      },
      priorContext: priorContext || undefined,
    };

    try {
      const result = await this.factExtractor.extractFromTurn(extractionInput);

      if (result.ok && result.facts.length > 0) {
        // Convert extracted facts to CreateFactInput for the repository
        const createInputs: CreateFactInput[] = result.facts.map(f => ({
          content: f.content,
          conversationId: f.conversationId,
          sourceMessageIds: f.sourceMessageIds,
          sourceTurnIndex: f.sourceTurnIndex ?? message.turnIndex,
          confidence: f.confidence,
          category: f.category,
          entities: f.entities,
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          summary: f.summary,
          frontmatter: f.frontmatter,
          metadata: f.metadata,
        }));

        const savedFacts = this.factRepo.createMany(createInputs);

        // Emit success event
        await this.eventBus.emit({
          type: 'facts.extracted' as const,
          conversationId,
          sourceMessageId: message.id,
          facts: savedFacts,
          timestamp: new Date().toISOString(),
        });
      } else if (!result.ok) {
        // Emit error event
        await this.eventBus.emit({
          type: 'extraction.error' as const,
          conversationId,
          sourceMessageId: message.id,
          error: result.error ?? 'Unknown extraction error',
          timestamp: new Date().toISOString(),
        });
      }
      // If ok but no facts — that's fine, nothing to emit
    } catch (err) {
      await this.eventBus.emit({
        type: 'extraction.error' as const,
        conversationId,
        sourceMessageId: message.id,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Find the user message immediately preceding the given turn index.
   */
  private findPrecedingUserMessage(
    messages: Array<{ id: string; role: string; content: string; turnIndex: number }>,
    assistantTurnIndex: number,
  ) {
    // Look backwards from the assistant message for the nearest user message
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
      .filter(m => m.turnIndex < currentTurnIndex - 1) // Exclude the current turn pair
      .slice(-this.contextWindowSize);

    if (priorMessages.length === 0) return '';

    return priorMessages
      .map(m => `[${m.role}]: ${m.content}`)
      .join('\n\n');
  }
}
