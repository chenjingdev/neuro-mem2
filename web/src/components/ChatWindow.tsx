import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import type { ChatMessage } from '../types';

interface ChatWindowProps {
  messages: ChatMessage[];
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  /** Currently selected message ID for trace highlight */
  selectedMessageId?: string | null;
  /** Callback when a message is clicked to view its traces */
  onSelectMessage?: (messageId: string | null) => void;
  /** Check if a message has associated trace data */
  hasTraces?: (messageId: string) => boolean;
  /** When true, hides the input area (for historical session viewing) */
  readOnly?: boolean;
}

/**
 * ChatWindow — main chat container composing MessageList + MessageInput.
 * Provides the complete chat interface with message display and input area.
 * When readOnly is true, the input area is hidden for historical session viewing.
 */
export function ChatWindow({
  messages,
  onSend,
  onStop,
  isStreaming,
  selectedMessageId,
  onSelectMessage,
  hasTraces,
  readOnly,
}: ChatWindowProps) {
  return (
    <div className={`chat-window ${readOnly ? 'chat-window-readonly' : ''}`}>
      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        selectedMessageId={selectedMessageId}
        onSelectMessage={onSelectMessage}
        hasTraces={hasTraces}
      />
      {readOnly ? (
        <div className="chat-readonly-banner">
          <span className="readonly-icon">📋</span>
          <span>Viewing saved session (read-only)</span>
        </div>
      ) : (
        <MessageInput
          onSend={onSend}
          onStop={onStop}
          isStreaming={isStreaming}
        />
      )}
    </div>
  );
}
