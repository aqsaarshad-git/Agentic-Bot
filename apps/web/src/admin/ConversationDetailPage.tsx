import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Conversation } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { StatusBadge } from '../shared/Badge';
import { formatDateTime } from '../shared/format';

export function ConversationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { token } = useAdminAuth();
  const [conversation, setConversation] = useState<Conversation | null>(null);

  useEffect(() => {
    if (!token || !id) return;
    apiFetch<Conversation>(`/conversations/${id}`, { token }).then(setConversation).catch(() => {});
  }, [token, id]);

  if (!conversation) return <p className="text-muted">Loading…</p>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Conversation transcript</h2>
          <p>
            <StatusBadge value={conversation.state} /> · {conversation.channel === 'VOICE' ? 'Voice call' : 'Chat'}
          </p>
        </div>
      </div>
      <div className="chat-messages" style={{ borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', minHeight: 200 }}>
        {(conversation.messages ?? []).map((m) => (
          <div key={m.id} className={`chat-message ${m.sender === 'CUSTOMER' ? 'customer' : 'ai'}`} style={{ maxWidth: '85%' }}>
            <span className="chat-message-label">{m.sender}</span>
            {m.content}
            <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>{formatDateTime(m.createdAt)}</div>
          </div>
        ))}
        {(conversation.messages ?? []).length === 0 && <p className="text-muted">No messages yet.</p>}
      </div>
    </div>
  );
}
