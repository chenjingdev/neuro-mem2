import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent } from 'react';

interface MessageInputProps {
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

/**
 * MessageInput — text input field with send/stop button.
 * Supports Enter to send, Shift+Enter for newlines.
 */
export function MessageInput({ onSend, onStop, isStreaming, disabled }: MessageInputProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus on mount and when streaming ends
  useEffect(() => {
    if (!isStreaming) {
      textareaRef.current?.focus();
    }
  }, [isStreaming]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
    }
  }, [input]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isStreaming || disabled) return;
    setInput('');
    onSend(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter adds newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const canSend = input.trim().length > 0 && !isStreaming && !disabled;

  return (
    <form className="message-input" onSubmit={handleSubmit}>
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={isStreaming ? 'Waiting for response...' : 'Type a message... (Enter to send, Shift+Enter for newline)'}
        disabled={isStreaming || disabled}
        rows={1}
        autoFocus
      />
      <div className="input-actions">
        {isStreaming ? (
          <button type="button" onClick={onStop} className="btn btn-stop" title="Stop generation">
            <StopIcon />
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!canSend} className="btn btn-send" title="Send message">
            <SendIcon />
            Send
          </button>
        )}
      </div>
    </form>
  );
}

/** Simple SVG send icon */
function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

/** Simple SVG stop icon */
function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}
