import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Call } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { StatusBadge } from '../shared/Badge';
import { formatDuration, formatRelativeTime } from '../shared/format';

export function CallsPage() {
  const { token } = useAdminAuth();
  const [calls, setCalls] = useState<Call[]>([]);

  useEffect(() => {
    if (!token) return;
    apiFetch<Call[]>('/calls', { token }).then(setCalls).catch(() => {});
  }, [token]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Calls</h2>
          <p>{calls.length} total voice calls</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Direction</th>
              <th>Channel</th>
              <th>Duration</th>
              <th>Outcome</th>
              <th>Started</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id}>
                <td>{c.customer?.fullName ?? c.customerId}</td>
                <td className="text-muted">{c.direction === 'INBOUND' ? 'Inbound' : 'Outbound'}</td>
                <td>
                  {c.transport === 'PSTN' ? (
                    <span className="badge badge-info" title={`${c.fromNumber ?? '?'} → ${c.toNumber ?? '?'}`}>
                      {c.direction === 'INBOUND' ? c.fromNumber ?? 'Phone' : c.toNumber ?? 'Phone'}
                    </span>
                  ) : (
                    <span className="text-muted">Browser</span>
                  )}
                </td>
                <td>{c.durationSeconds != null ? formatDuration(c.durationSeconds) : <span className="badge badge-info">In progress</span>}</td>
                <td>
                  {c.escalationStatus !== 'NONE' ? <StatusBadge value={c.escalationStatus} /> : <StatusBadge value={c.outcome} />}
                </td>
                <td className="text-muted" title={new Date(c.startTime).toLocaleString()}>
                  {formatRelativeTime(c.startTime)}
                </td>
                <td>
                  {c.conversationId && (
                    <Link to={`/admin/conversations/${c.conversationId}`} style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}>
                      Transcript
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
