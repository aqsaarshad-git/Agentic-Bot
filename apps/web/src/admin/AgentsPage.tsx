import { FormEvent, useEffect, useState } from 'react';
import type { AiAgent } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { StatusBadge } from '../shared/Badge';

const AVAILABLE_TOOLS = [
  'get_customer',
  'create_ticket',
  'get_ticket',
  'update_ticket',
  'escalate_ticket',
  'transfer_to_human',
  'end_call',
  'schedule_callback',
  'get_account',
  'get_balance',
  'get_transactions',
];

export function AgentsPage() {
  const { token } = useAdminAuth();
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [name, setName] = useState('');
  const [systemInstructions, setSystemInstructions] = useState('');
  const [languages, setLanguages] = useState('ar,en');
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    if (!token) return;
    apiFetch<AiAgent[]>('/agents', { token }).then(setAgents).catch(() => {});
  }

  useEffect(load, [token]);

  function toggleTool(tool: string) {
    setAllowedTools((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    try {
      await apiFetch('/agents', {
        method: 'POST',
        token,
        body: {
          name,
          systemInstructions,
          supportedLanguages: languages.split(',').map((l) => l.trim()).filter(Boolean),
          allowedTools,
        },
      });
      setName('');
      setSystemInstructions('');
      setAllowedTools([]);
      load();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>AI Agents</h2>
          <p>{agents.length} configured</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Languages</th>
              <th>Allowed tools</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const tools = a.configs[0]?.allowedTools ?? [];
              const shown = tools.slice(0, 3);
              const extra = tools.length - shown.length;
              return (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>{a.name}</td>
                  <td>
                    <StatusBadge value={a.status} />
                  </td>
                  <td className="text-muted">
                    {(a.configs[0]?.supportedLanguages ?? []).map((l) => (l === 'ar' ? 'Arabic' : l === 'en' ? 'English' : l)).join(', ')}
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {shown.map((tool) => (
                        <span key={tool} className="badge badge-neutral mono">{tool}</span>
                      ))}
                      {extra > 0 && <span className="badge badge-neutral">+{extra} more</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 16 }}>New agent</h3>
        <form onSubmit={onSubmit}>
          <div className="field">
            <label>Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label>System instructions</label>
            <textarea
              className="input"
              rows={4}
              value={systemInstructions}
              onChange={(e) => setSystemInstructions(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label>Supported languages (comma-separated)</label>
            <input className="input" value={languages} onChange={(e) => setLanguages(e.target.value)} />
          </div>
          <div className="field">
            <label>Allowed tools</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {AVAILABLE_TOOLS.map((tool) => (
                <label key={tool} style={{ fontWeight: 400, fontSize: 13.5 }}>
                  <input
                    type="checkbox"
                    checked={allowedTools.includes(tool)}
                    onChange={() => toggleTool(tool)}
                  />{' '}
                  {tool}
                </label>
              ))}
            </div>
          </div>
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create agent'}
          </button>
        </form>
      </div>
    </div>
  );
}
