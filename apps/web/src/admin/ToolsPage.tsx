import { useEffect, useState } from 'react';
import type { Tool } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';

export function ToolsPage() {
  const { token } = useAdminAuth();
  const [tools, setTools] = useState<Tool[]>([]);

  function load() {
    if (!token) return;
    apiFetch<Tool[]>('/tools', { token }).then(setTools).catch(() => {});
  }

  useEffect(load, [token]);

  async function toggle(tool: Tool) {
    if (!token) return;
    await apiFetch(`/tools/${tool.id}`, { method: 'PATCH', token, body: { isEnabled: !tool.isEnabled } });
    load();
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Tools</h2>
          <p>Disabling a tool takes effect immediately — the agent stops offering it and any attempted call is rejected.</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.name}</td>
                <td className="text-muted" style={{ maxWidth: 420 }}>{t.description}</td>
                <td>
                  <span className={`badge badge-${t.isEnabled ? 'success' : 'neutral'}`}>
                    {t.isEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </td>
                <td>
                  <button className="btn btn-ghost" onClick={() => toggle(t)}>
                    {t.isEnabled ? 'Disable' : 'Enable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
