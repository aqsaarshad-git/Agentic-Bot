import { FormEvent, useEffect, useState } from 'react';
import type { StaffUser } from 'shared-types';
import { apiFetch, ApiError } from '../shared/api';
import { useAdminAuth } from '../shared/AdminAuthContext';
import { StatusBadge } from '../shared/Badge';
import { formatDateTime } from '../shared/format';

const ROLE_OPTIONS = ['AGENT', 'SUPERVISOR', 'ADMIN'];

export function HumanAgentsPage() {
  const { token } = useAdminAuth();
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleName, setRoleName] = useState('AGENT');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    if (!token) return;
    apiFetch<StaffUser[]>('/users', { token }).then(setStaff).catch(() => {});
  }

  useEffect(load, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch('/auth/register', { method: 'POST', token, body: { name, email, password, roleName } });
      setName('');
      setEmail('');
      setPassword('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create staff account');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Human Agents</h2>
          <p>{staff.length} staff accounts</p>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id}>
                <td style={{ fontWeight: 600 }}>{s.name}</td>
                <td className="text-muted">{s.email}</td>
                <td>
                  <StatusBadge value={s.role.name} />
                </td>
                <td className="text-muted">{formatDateTime(s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 16 }}>New staff account</h3>
        <form onSubmit={onSubmit}>
          <div className="field">
            <label>Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label>Email</label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label>Temporary password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>
          <div className="field">
            <label>Role</label>
            <select className="input" value={roleName} onChange={(e) => setRoleName(e.target.value)}>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: 13.5 }}>{error}</p>}
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
