import { FormEvent, useEffect, useState } from 'react';
import type { Campaign, CampaignStatus, Customer } from 'shared-types';
import { apiFetch } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { StatusBadge } from '../shared/Badge';

const STATUS_OPTIONS: CampaignStatus[] = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED'];

export function CampaignsPage() {
  const { token } = useAdminAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [name, setName] = useState('Payment Reminder');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [script, setScript] = useState(
    "Hi, this is a reminder that your recent payment didn't go through. Would you like help resolving it now?",
  );
  const [selectedCustomers, setSelectedCustomers] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    if (!token) return;
    apiFetch<Campaign[]>('/campaigns', { token }).then(setCampaigns).catch(() => {});
  }

  useEffect(load, [token]);
  useEffect(() => {
    if (!token) return;
    apiFetch<Customer[]>('/customers', { token }).then(setCustomers).catch(() => {});
  }, [token]);

  function toggleCustomer(id: string) {
    setSelectedCustomers((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token || selectedCustomers.length === 0) return;
    setSubmitting(true);
    try {
      await apiFetch('/campaigns', {
        method: 'POST',
        token,
        body: { name, startDate, script, customerIds: selectedCustomers },
      });
      setSelectedCustomers([]);
      load();
    } finally {
      setSubmitting(false);
    }
  }

  async function updateStatus(id: string, status: CampaignStatus) {
    if (!token) return;
    await apiFetch(`/campaigns/${id}`, { method: 'PATCH', token, body: { status } });
    load();
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Campaigns</h2>
          <p>Set a campaign to Active and the scheduler places each call automatically, opening with your script.</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Contacts</th>
              <th>Window</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td style={{ fontWeight: 600 }}>{c.name}</td>
                <td>
                  <StatusBadge value={c.status} />
                </td>
                <td>{c._count?.contacts ?? 0}</td>
                <td className="text-muted">
                  {new Date(c.startDate).toLocaleDateString()}
                  {c.endDate ? ` – ${new Date(c.endDate).toLocaleDateString()}` : ''}
                </td>
                <td>
                  <select className="input" value={c.status} onChange={(e) => updateStatus(c.id, e.target.value as CampaignStatus)}>
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 16 }}>New campaign</h3>
        <form onSubmit={onSubmit}>
          <div className="field">
            <label>Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label>Start date</label>
            <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </div>
          <div className="field">
            <label>Opening script</label>
            <textarea className="input" rows={3} value={script} onChange={(e) => setScript(e.target.value)} />
          </div>
          <div className="field">
            <label>Customers to call ({selectedCustomers.length} selected)</label>
            <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10 }}>
              {customers.map((c) => (
                <label key={c.id} style={{ display: 'block', fontWeight: 400, padding: '3px 0', fontSize: 13.5 }}>
                  <input
                    type="checkbox"
                    checked={selectedCustomers.includes(c.id)}
                    onChange={() => toggleCustomer(c.id)}
                  />{' '}
                  {c.fullName} {c.email ? `(${c.email})` : ''}
                </label>
              ))}
              {customers.length === 0 && <p className="text-muted">No customers yet.</p>}
            </div>
          </div>
          <button className="btn" type="submit" disabled={submitting || selectedCustomers.length === 0}>
            {submitting ? 'Creating…' : 'Create campaign (starts as draft)'}
          </button>
        </form>
      </div>
    </div>
  );
}
