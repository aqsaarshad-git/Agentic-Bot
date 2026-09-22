import { useEffect, useState } from 'react';
import type { AuditLogEntry } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { formatRelativeTime, shortId } from '../shared/format';

export function AuditLogsPage() {
  const { token } = useAdminAuth();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);

  useEffect(() => {
    if (!token) return;
    apiFetch<AuditLogEntry[]>('/audit-logs', { token }).then(setLogs).catch(() => {});
  }, [token]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Audit Logs</h2>
          <p>Every action the system and AI agents took, for tracing and compliance.</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Tool</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="text-muted" title={new Date(l.createdAt).toLocaleString()}>
                  {formatRelativeTime(l.createdAt)}
                </td>
                <td>
                  {l.actorType}
                  {l.actorId ? <span className="mono" title={l.actorId}> · {shortId(l.actorId)}</span> : ''}
                </td>
                <td className="mono">{l.action}</td>
                <td>
                  {l.entityType ?? '—'}
                  {l.entityId ? <span className="mono" title={l.entityId}> · {shortId(l.entityId)}</span> : ''}
                </td>
                <td className="text-muted">{l.toolName ?? '—'}</td>
                <td>
                  <span className={`badge badge-${l.success ? 'success' : 'danger'}`}>
                    {l.success ? 'Success' : 'Failure'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
