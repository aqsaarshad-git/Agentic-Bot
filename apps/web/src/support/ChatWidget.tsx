import { FormEvent, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Send } from 'lucide-react';
import type { ConversationState, MessageSender, SendMessageResponse } from 'shared-types';
import { apiFetch, ApiError } from '../shared/api';
import { StatusBadge } from '../shared/Badge';

interface ChatMessage {
  sender: MessageSender;
  content: string;
  /** Shown immediately on send, before the backend confirms it over the socket. */
  pending?: boolean;
  /** Only set on AI messages — the transcript-based classification of the customer's
   *  preceding message that shaped this reply (and, on a call, its TTS tone). */
  emotion?: string;
  sentiment?: string;
  urgency?: string;
}

const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? 'http://localhost:3000';

export function ChatWidget({
  conversationId,
  token,
  onUnauthorized,
}: {
  conversationId: string;
  token: string;
  onUnauthorized?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<ConversationState>('CALL_STARTED');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = io(`${API_ORIGIN}/conversations`, { auth: { token } });
    socketRef.current = socket;
    socket.emit('join', { conversationId });
    socket.on('message', (msg: ChatMessage) => {
      setMessages((prev) => {
        // The backend echoes the customer's own message back over the socket — if it
        // matches a message we already showed optimistically, reconcile in place instead
        // of appending a visible duplicate.
        if (msg.sender === 'CUSTOMER') {
          const idx = prev.findIndex((m) => m.pending && m.sender === 'CUSTOMER' && m.content === msg.content);
          if (idx !== -1) {
            const next = [...prev];
            next[idx] = { ...msg, pending: false };
            return next;
          }
        }
        return [...prev, msg];
      });
    });
    socket.on('state', (payload: { state: ConversationState }) => setState(payload.state));
    // The gateway silently disconnects on a bad/expired token (see chat.gateway.ts) rather
    // than emitting an error, so a stale token otherwise looks like the socket "just never
    // sends anything" with no visible cause.
    socket.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') {
        setError('Your session has expired. Please verify your identity again.');
        onUnauthorized?.();
      }
    });
    return () => {
      socket.disconnect();
    };
  }, [conversationId, token]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || sending) return;
    setSending(true);
    setError(null);
    const content = input;
    setInput('');
    // Show the customer's own message immediately rather than waiting for it to round-trip
    // back over the socket — real inference can take 10-20s+, and it should never look like
    // sending silently did nothing for that whole time. The backend also broadcasts this
    // same message (so a staff view watching live still sees it), which the socket handler
    // below dedupes against this optimistic copy.
    setMessages((prev) => [...prev, { sender: 'CUSTOMER', content, pending: true }]);
    try {
      await apiFetch<SendMessageResponse>(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        token,
        body: { content },
      });
      // The AI's reply arrives over the socket; no need to append it locally.
    } catch (err) {
      // Put the text back so the customer doesn't lose what they typed, drop the optimistic
      // bubble since it was never actually sent, and surface what happened.
      setInput(content);
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.pending && m.sender === 'CUSTOMER' && m.content === content);
        return idx === -1 ? prev : [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      });
      if (err instanceof ApiError && err.status === 401) {
        setError('Your session has expired. Please verify your identity again.');
        onUnauthorized?.();
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to send message. Please try again.');
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        Status: <StatusBadge value={state} />
      </p>
      {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
      <div className="chat-window">
        <div className="chat-messages">
          {messages.map((m, i) => (
            <div key={i} className={`chat-message ${m.sender === 'CUSTOMER' ? 'customer' : 'ai'}`}>
              {m.content}
              {m.sender === 'AI' && m.emotion && (
                <div className="chat-message-meta">
                  Detected: {m.emotion}
                  {m.sentiment ? ` · ${m.sentiment}` : ''}
                  {m.urgency && m.urgency !== 'low' ? ` · ${m.urgency} urgency` : ''}
                </div>
              )}
            </div>
          ))}
          {sending && (
            <div className="chat-message ai chat-message-typing">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <form className="chat-input-row" onSubmit={onSubmit}>
          <input
            placeholder="Type a message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={sending}
          />
          <button className="btn" type="submit" disabled={sending}>
            <Send size={15} />
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
