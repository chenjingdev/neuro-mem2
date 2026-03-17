/**
 * Conversation Ingestion Service.
 * Entry point for storing raw conversation data.
 * Ensures original data is preserved immutably.
 *
 * When an EventBus is provided, emits 'turn.completed' events
 * after each message append, enabling the real-time extraction pipeline.
 *
 * When a SessionManager is provided, automatically touches the session
 * on each message append and can auto-create sessions.
 */

import type { ConversationRepository } from '../db/conversation-repo.js';
import type { EventBus } from '../events/event-bus.js';
import type { SessionManager } from './session-manager.js';
import type {
  RawConversation,
  RawMessage,
  IngestConversationInput,
  AppendMessageInput,
} from '../models/conversation.js';

export interface IngestServiceOptions {
  /**
   * When true, automatically creates a session for newly ingested conversations
   * and touches the session on each message append. Default: false
   */
  autoSession?: boolean;
}

export class IngestService {
  private eventBus: EventBus | null;
  private sessionManager: SessionManager | null;
  private autoSession: boolean;

  constructor(
    private repo: ConversationRepository,
    eventBus?: EventBus,
    sessionManager?: SessionManager,
    options: IngestServiceOptions = {},
  ) {
    this.eventBus = eventBus ?? null;
    this.sessionManager = sessionManager ?? null;
    this.autoSession = options.autoSession ?? false;
  }

  /**
   * Ingest a complete conversation with all its messages.
   * Each message is stored as an immutable record.
   * Emits 'turn.completed' for each message if EventBus is attached.
   * If autoSession is enabled, creates a session for the conversation.
   */
  ingestConversation(input: IngestConversationInput): RawConversation {
    if (!input.source) {
      throw new Error('Conversation source is required');
    }
    if (!input.messages || input.messages.length === 0) {
      throw new Error('At least one message is required');
    }

    for (const msg of input.messages) {
      if (!msg.content) {
        throw new Error('Message content cannot be empty');
      }
      if (!['user', 'assistant', 'system'].includes(msg.role)) {
        throw new Error(`Invalid role: ${msg.role}`);
      }
    }

    const conversation = this.repo.ingest(input);

    // Auto-create session if enabled
    if (this.autoSession && this.sessionManager) {
      this.sessionManager.startSession({
        conversationId: conversation.id,
      });
    }

    // Emit turn.completed for each message in the ingested conversation
    if (this.eventBus) {
      for (const message of conversation.messages) {
        // Fire-and-forget: don't await, don't block ingestion
        void this.eventBus.emit({
          type: 'turn.completed' as const,
          conversationId: conversation.id,
          message,
          timestamp: new Date().toISOString(),
        });
      }
    }

    return conversation;
  }

  /**
   * Append a new message to an existing conversation.
   * This supports per-turn ingestion for real-time use.
   * Emits 'turn.completed' event if EventBus is attached.
   * Touches the associated session if SessionManager is attached.
   */
  appendMessage(input: AppendMessageInput): RawMessage {
    if (!input.conversationId) {
      throw new Error('Conversation ID is required');
    }
    if (!input.content) {
      throw new Error('Message content cannot be empty');
    }

    // Verify conversation exists
    const conv = this.repo.getConversation(input.conversationId);
    if (!conv) {
      throw new Error(`Conversation not found: ${input.conversationId}`);
    }

    const message = this.repo.appendMessage(input);

    // Touch the session to keep it alive (heartbeat on activity)
    if (this.sessionManager) {
      const activeSession = this.sessionManager.getActiveSession(input.conversationId);
      if (activeSession) {
        this.sessionManager.touchSession(activeSession.id);
      } else if (this.autoSession) {
        // Auto-create a session if none exists
        this.sessionManager.startSession({
          conversationId: input.conversationId,
        });
      }
    }

    // Emit turn.completed event for the pipeline
    if (this.eventBus) {
      void this.eventBus.emit({
        type: 'turn.completed' as const,
        conversationId: input.conversationId,
        message,
        timestamp: new Date().toISOString(),
      });
    }

    return message;
  }

  /**
   * Retrieve a conversation with all messages.
   */
  getConversation(conversationId: string): RawConversation | null {
    return this.repo.getConversation(conversationId);
  }

  /**
   * List conversations with optional filtering.
   */
  listConversations(options?: { limit?: number; offset?: number; source?: string }): RawConversation[] {
    return this.repo.listConversations(options);
  }
}
