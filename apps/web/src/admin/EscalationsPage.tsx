import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import type { Conversation } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { formatRelativeTime } from '../shared/format';

export function EscalationsPage() {
  const { token } = useAdminAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);

  function load() {
    if (!token) return;
    apiFetch<Conversation[]>('/conversations?state=ESCALATING', { token }).then(setConversations).catch(() => {});
  }

  useEffect(load, [token]);

  async function markResolved(id: string) {
    if (!token) return;
    await apiFetch(`/conversations/${id}/handled`, { method: 'PATCH', token, body: { state: 'RESOLVING' } });
    load();
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Escalations</h2>
          <p>Conversations the AI couldn't resolve on its own — summary and full transcript, no need to ask the customer to repeat anything.</p>
        </div>
      </div>
      {conversations.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '32px 20px' }}>
          Nothing waiting on a human right now.
        </div>
      )}
      {conversations.map((c) => (
        <div key={c.id} className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="badge badge-warning">
                <AlertTriangle size={12} />
                Escalated
              </span>
              <strong>{c.customer?.fullName ?? c.customerId}</strong>
            </div>
            <span className="text-muted" style={{ fontSize: 12 }}>
              {formatRelativeTime(c.createdAt)}
            </span>
          </div>
          <p style={{ margin: '10px 0', color: 'var(--text)' }}>{c.summaries?.[0]?.summary ?? 'No AI summary generated yet.'}</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Link to={`/admin/conversations/${c.id}`} style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}>
              View transcript
            </Link>
            <button className="btn btn-secondary" onClick={() => markResolved(c.id)}>
              Mark resolved
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
