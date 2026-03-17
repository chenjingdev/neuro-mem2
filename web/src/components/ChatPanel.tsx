import { useState, useRef, useEffect, type FormEvent } from 'react';
import type { ChatMessage } from '../types';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
}

export function ChatPanel({ messages, onSend, onStop, isStreaming }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput('');
    onSend(trimmed);
  };

  return (
    <div className="chat-panel">
      <div className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            Send a message to test the memory pipeline.
            <br />
            Trace events will appear in the right panel.
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`message message-${msg.role}${msg.isError ? ' message-error' : ''}`}
          >
            <span className="message-role">{msg.role}</span>
            <div className="message-content">
              {msg.content || (msg.isStreaming ? '...' : '')}
              {msg.isStreaming && <span className="streaming-cursor" />}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <form className="chat-input" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Type a message..."
          disabled={isStreaming}
          autoFocus
        />
        {isStreaming ? (
          <button type="button" onClick={onStop} className="btn-stop">Stop</button>
        ) : (
          <button type="submit" disabled={!input.trim()}>Send</button>
        )}
      </form>
    </div>
  );
}
