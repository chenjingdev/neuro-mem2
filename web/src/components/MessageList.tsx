import { useRef, useEffect } from 'react';
import type { ChatMessage } from '../types';

interface MessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  /** Currently selected message ID for trace highlight */
  selectedMessageId?: string | null;
  /** Callback when a message is clicked to view its traces */
  onSelectMessage?: (messageId: string | null) => void;
  /** Check if a message has associated trace data */
  hasTraces?: (messageId: string) => boolean;
}

/**
 * MessageList — renders the scrollable list of chat messages.
 * Auto-scrolls to the bottom as new content arrives.
 * Messages with trace data are clickable to view their pipeline traces.
 */
export function MessageList({
  messages,
  isStreaming,
  selectedMessageId,
  onSelectMessage,
  hasTraces,
}: MessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleClick = (msgId: string) => {
    if (!onSelectMessage) return;
    // Toggle: deselect if already selected
    if (selectedMessageId === msgId) {
      onSelectMessage(null);
    } else {
      onSelectMessage(msgId);
    }
  };

  if (messages.length === 0) {
    return (
      <div className="message-list">
        <div className="empty-state">
          Send a message to test the memory pipeline.
          <br />
          Trace events will appear in the right panel.
        </div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={containerRef}>
      {messages.map((msg) => {
        const msgHasTraces = hasTraces ? hasTraces(msg.id) : false;
        const isSelected = selectedMessageId === msg.id;

        return (
          <div
            key={msg.id}
            className={[
              'message',
              `message-${msg.role}`,
              msg.isError ? 'message-error' : '',
              msgHasTraces ? 'message-has-traces' : '',
              isSelected ? 'message-selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={msgHasTraces ? () => handleClick(msg.id) : undefined}
            role={msgHasTraces ? 'button' : undefined}
            tabIndex={msgHasTraces ? 0 : undefined}
            title={msgHasTraces ? 'Click to view pipeline trace' : undefined}
          >
            <div className="message-header">
              <span className="message-role">{msg.role}</span>
              <span className="message-time">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
              {msgHasTraces && (
                <span className="message-trace-badge" title="Has pipeline trace data">
                  trace
                </span>
              )}
            </div>
            <div className="message-content">
              {msg.content || (msg.isStreaming ? (
                <span className="streaming-indicator">
                  <span className="dot dot-1" />
                  <span className="dot dot-2" />
                  <span className="dot dot-3" />
                </span>
              ) : '')}
            </div>
            {msg.isStreaming && msg.content && (
              <span className="streaming-cursor" />
            )}
          </div>
        );
      })}
      <div ref={messagesEndRef} />
    </div>
  );
}
