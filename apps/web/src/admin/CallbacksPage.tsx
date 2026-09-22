import { useEffect, useState } from 'react';
import type { CallbackEntry } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { StatusBadge } from '../shared/Badge';

export function CallbacksPage() {
  const { token } = useAdminAuth();
  const [callbacks, setCallbacks] = useState<CallbackEntry[]>([]);

  function load() {
    if (!token) return;
    apiFetch<CallbackEntry[]>('/callbacks', { token }).then(setCallbacks).catch(() => {});
  }

  useEffect(load, [token]);

  async function cancel(id: string) {
    if (!token) return;
    await apiFetch(`/callbacks/${id}/cancel`, { method: 'PATCH', token });
    load();
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Callbacks</h2>
          <p>Placed automatically by the scheduler once the requested time arrives.</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Requested for</th>
              <th>Reason</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {callbacks.map((c) => (
              <tr key={c.id}>
                <td>{c.customer?.fullName ?? c.customerId}</td>
                <td>
                  {new Date(c.requestedDate).toLocaleDateString()} at {c.requestedTime}
                </td>
                <td className="text-muted">{c.reason ?? '—'}</td>
                <td>
                  <StatusBadge value={c.status} />
                </td>
                <td>
                  {c.status === 'PENDING' && (
                    <button className="btn btn-ghost" onClick={() => cancel(c.id)}>
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {callbacks.length === 0 && (
              <tr>
                <td colSpan={5} className="text-muted">
                  No callbacks requested yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
