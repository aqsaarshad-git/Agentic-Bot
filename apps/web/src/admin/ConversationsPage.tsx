import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Conversation } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { StatusBadge } from '../shared/Badge';
import { formatRelativeTime } from '../shared/format';

export function ConversationsPage() {
  const { token } = useAdminAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);

  useEffect(() => {
    if (!token) return;
    apiFetch<Conversation[]>('/conversations', { token }).then(setConversations).catch(() => {});
  }, [token]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Conversations</h2>
          <p>{conversations.length} total, across chat and voice</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Channel</th>
              <th>State</th>
              <th>Intent</th>
              <th>Started</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {conversations.map((c) => (
              <tr key={c.id}>
                <td>{c.channel === 'VOICE' ? 'Voice' : 'Chat'}</td>
                <td>
                  <StatusBadge value={c.state} />
                </td>
                <td className="text-muted">{c.intent ?? '—'}</td>
                <td className="text-muted" title={new Date(c.createdAt).toLocaleString()}>
                  {formatRelativeTime(c.createdAt)}
                </td>
                <td>
                  <Link to={`/admin/conversations/${c.id}`} style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}>
                    View transcript
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
